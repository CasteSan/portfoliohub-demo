/**
 * Motor de evolución de patrimonio — Fase C.2
 *
 * Funciones PURAS extraídas de los dos endpoints de evolución
 * (`/api/dashboard/evolution` y `/api/portfolios/[id]/evolution`), que
 * duplicaban ~110 líneas literalmente idénticas. Los endpoints conservan
 * su capa de auth + queries + envelope JSON; aquí vive solo el cálculo.
 *
 * MODO PROFESOR — ¿Por qué "motor" separado?
 * Es el mismo patrón que el motor fiscal de `lib/tax`: la lógica de negocio
 * en funciones puras (entrada → salida, sin BD ni red) se puede testear con
 * fixtures derivados a mano, y el cambio de renderer de la Fase C (C.4) o el
 * downsampling (C.5) se hacen UNA vez aquí, no en cada endpoint. Es como
 * separar la reducción del espectro (pipeline puro) de la lectura del FITS.
 *
 * El algoritmo (enfoque híbrido, ver docstring de los endpoints):
 * 1. Unión de fechas de todos los históricos, recortada a la 1ª transacción
 * 2. Forward-fill por instrumento (último precio conocido; avgCost como
 *    fallback antes del primer precio)
 * 3. Transaction replay: reconstruye participaciones y coste invertido
 *    (coste medio ponderado; las ventas reducen proporcionalmente)
 * 4. Valor diario = Σ shares × precio · Invertido diario = Σ cost basis
 */

import { type EvolutionDataPoint } from "@/lib/price-providers/types";
import { convert, coverageReport, normalizeCurrency, type FxCoverage, type FxTable } from "@/lib/fx-utils";

/** Instrumento con su fallback de precio (avgCost de la posición) */
export type EngineInstrument = {
  instrumentId: string;
  avgCost: number;
  /** Divisa del instrumento (Fase E): solo la usa la conversión previa */
  currency?: string;
  /** Coste medio en divisa base (Position.avgCostBase): fallback convertido */
  avgCostBase?: number | null;
  /** Etiqueta para la cobertura FX (ticker) */
  label?: string;
};

/** Transacción ya normalizada (números planos, fecha ISO yyyy-mm-dd) */
export type EngineTransaction = {
  instrumentId: string;
  type: "BUY" | "SELL" | "TRANSFER_IN" | "TRANSFER_OUT";
  shares: number;
  pricePerShare: number;
  /** yyyy-mm-dd (UTC), igual que las claves de los mapas de precios */
  tradeDate: string;
};

/** instrumentId → (yyyy-mm-dd → precio de cierre) */
export type PriceHistories = Map<string, Map<string, number>>;

/**
 * Unión ordenada de las fechas de todos los históricos, recortada para no
 * empezar antes de la primera transacción (evita "datos fantasma" de un
 * periodo en el que la cartera no existía).
 */
export function collectSortedDates(
  priceHistories: PriceHistories,
  firstTxDate: string | null
): string[] {
  const allDates = new Set<string>();
  for (const priceMap of priceHistories.values()) {
    for (const date of priceMap.keys()) {
      allDates.add(date);
    }
  }
  let sortedDates = Array.from(allDates).sort();

  if (firstTxDate) {
    sortedDates = sortedDates.filter((d) => d >= firstTxDate);
  }
  return sortedDates;
}

/**
 * Forward-fill por instrumento: cada fecha de la unión recibe el último
 * precio conocido de ese instrumento; antes del primer precio, avgCost.
 * (Evita los "picos" diente de sierra cuando un fondo solo cotiza a veces.)
 */
export function forwardFillHistories(
  instruments: EngineInstrument[],
  priceHistories: PriceHistories,
  sortedDates: string[]
): PriceHistories {
  const filledHistories: PriceHistories = new Map();

  for (const instrument of instruments) {
    const rawPriceMap = priceHistories.get(instrument.instrumentId);
    const filled = new Map<string, number>();
    let lastKnownPrice: number | null = null;

    for (const dateStr of sortedDates) {
      if (rawPriceMap) {
        const price = rawPriceMap.get(dateStr);
        if (price !== undefined) {
          lastKnownPrice = price;
        }
      }

      if (lastKnownPrice !== null) {
        filled.set(dateStr, lastKnownPrice);
      } else {
        filled.set(dateStr, instrument.avgCost);
      }
    }

    filledHistories.set(instrument.instrumentId, filled);
  }

  return filledHistories;
}

/**
 * Transaction replay + serie de evolución.
 *
 * Recorre las fechas con un puntero sobre las transacciones (ordenadas ASC):
 * - BUY/TRANSFER_IN: suma shares y coste (shares × precio)
 * - SELL/TRANSFER_OUT: resta shares; el coste se reduce proporcionalmente
 *   (coste medio ponderado). Si quedan ≤0.0001 shares, la posición se cierra.
 *
 * En cada fecha: value = Σ shares × precio_forward_fill; invested = Σ coste;
 * cumFlow = flujo externo neto acumulado a precios de transacción (ver el
 * docstring del tipo EvolutionDataPoint — es la base del cashflow del TWR;
 * `invested` NO sirve para eso porque una venta retira cost basis, no los
 * ingresos reales, y la plusvalía aparecería como pérdida fantasma).
 *
 * ⚠️ ALCANCE DEL ENFOQUE HÍBRIDO: `instruments` viene de las POSICIONES
 * ACTUALES, así que un instrumento comprado y vendido del todo en el pasado
 * no existe para esta serie — value/invested nunca lo han contado (limitación
 * preexistente, documentada desde la auditoría). Las transacciones de esos
 * instrumentos se SALTAN enteras: si sus flujos entraran en cumFlow sin que
 * su valor entre en value, cada compra/venta suya aparecería como pérdida/
 * ganancia fantasma del TWR (medido en la BD real: TWR de −154% en carteras
 * con muchos instrumentos rotados).
 */
export function replayEvolution(
  instruments: EngineInstrument[],
  filledHistories: PriceHistories,
  transactions: EngineTransaction[],
  sortedDates: string[]
): EvolutionDataPoint[] {
  // Solo los instrumentos con posición actual entran en la serie (ver ⚠️ arriba)
  const trackedInstruments = new Set(instruments.map((i) => i.instrumentId));
  const positionMap = new Map<string, number>(); // instrumentId → shares
  const costBasisMap = new Map<string, number>(); // instrumentId → coste invertido
  let cumFlow = 0; // flujo externo neto acumulado a precios de transacción
  let txIndex = 0;
  const evolution: EvolutionDataPoint[] = [];

  for (const dateStr of sortedDates) {
    // Avanzar puntero: procesar transacciones hasta esta fecha
    while (txIndex < transactions.length) {
      const tx = transactions[txIndex];
      if (tx.tradeDate > dateStr) break;

      if (!trackedInstruments.has(tx.instrumentId)) {
        txIndex++;
        continue;
      }

      const currentShares = positionMap.get(tx.instrumentId) || 0;
      const currentCost = costBasisMap.get(tx.instrumentId) || 0;

      switch (tx.type) {
        case "BUY":
        case "TRANSFER_IN":
          positionMap.set(tx.instrumentId, currentShares + tx.shares);
          costBasisMap.set(tx.instrumentId, currentCost + tx.shares * tx.pricePerShare);
          cumFlow += tx.shares * tx.pricePerShare;
          break;
        case "SELL":
        case "TRANSFER_OUT": {
          cumFlow -= tx.shares * tx.pricePerShare;
          const newShares = currentShares - tx.shares;
          if (newShares <= 0.0001) {
            positionMap.delete(tx.instrumentId);
            costBasisMap.delete(tx.instrumentId);
          } else {
            const avgCostPerShare = currentShares > 0 ? currentCost / currentShares : 0;
            positionMap.set(tx.instrumentId, newShares);
            costBasisMap.set(tx.instrumentId, newShares * avgCostPerShare);
          }
          break;
        }
      }

      txIndex++;
    }

    // Valor de mercado y coste invertido del día
    let totalValue = 0;
    let totalInvested = 0;
    for (const instrument of instruments) {
      const shares = positionMap.get(instrument.instrumentId) || 0;
      if (shares <= 0) continue;

      const filled = filledHistories.get(instrument.instrumentId);
      const price = filled?.get(dateStr) ?? instrument.avgCost;
      totalValue += shares * price;
      totalInvested += costBasisMap.get(instrument.instrumentId) || 0;
    }

    evolution.push({
      date: dateStr,
      value: Math.round(totalValue * 100) / 100,
      invested: Math.round(totalInvested * 100) / 100,
      cumFlow: Math.round(cumFlow * 100) / 100,
    });
  }

  return evolution;
}

/** Umbral de downsampling: rangos de más de 2 años se reducen a semanal */
const DOWNSAMPLE_THRESHOLD_DAYS = 730;

const MS_PER_DAY = 86_400_000;

/**
 * Clave de semana ISO 8601 ("2025-W01") de una fecha yyyy-mm-dd.
 *
 * MODO PROFESOR — ¿Por qué semana ISO y no "cada 7 días desde el inicio"?
 * La semana ISO es determinista y universal: lunes a domingo, la semana 1
 * es la que contiene el primer jueves del año. Dos series distintas caen
 * en los MISMOS buckets (clave para comparar cartera vs benchmark), y los
 * bordes de año quedan bien definidos (el 30-dic-2024, lunes, pertenece a
 * 2025-W01 — el algoritmo usa el año del jueves de esa semana).
 */
export function isoWeekKey(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7; // lunes=0 ... domingo=6
  // El jueves de esta semana decide el año ISO
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() - weekday + 3);
  const isoYear = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((thursday.getTime() - jan1.getTime()) / MS_PER_DAY + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * Downsampling semanal por ÚLTIMA observación (estándar financiero: el
 * valor de la semana es su cierre). Solo actúa si el rango de la serie
 * supera los 730 días; siempre preserva el primer y el último punto.
 *
 * ¿Por qué última observación y no LTTB? El navegador no necesita 1.300
 * puntos para pintar 900px. LTTB conserva mejor la forma visual, pero es
 * más código para un beneficio marginal en curvas de patrimonio; el
 * cierre semanal es determinista y trivial de testear (decisión del plan).
 */
export function downsampleWeekly(points: EvolutionDataPoint[]): EvolutionDataPoint[] {
  if (points.length < 2) return points;

  const first = points[0];
  const last = points[points.length - 1];
  const spanDays = (Date.parse(last.date) - Date.parse(first.date)) / MS_PER_DAY;
  if (spanDays <= DOWNSAMPLE_THRESHOLD_DAYS) return points;

  // El último punto de cada semana gana (los puntos vienen ordenados ASC),
  // y el orden de inserción del Map conserva el orden temporal
  const byWeek = new Map<string, EvolutionDataPoint>();
  for (const point of points) {
    byWeek.set(isoWeekKey(point.date), point);
  }

  const result = [...byWeek.values()];
  // El último punto siempre es el cierre de su semana → ya está incluido.
  // El primero puede no serlo → preservarlo explícitamente.
  if (result[0] !== first) {
    result.unshift(first);
  }
  return result;
}

/**
 * Pipeline completo: fechas → forward-fill → replay → downsampling.
 * `transactions` DEBE venir ordenado por tradeDate ASC (los endpoints ya
 * consultan con `orderBy: { tradeDate: "asc" }`).
 *
 * ⚠️ `downsample: false` es OBLIGATORIO para consumidores ANALÍTICOS
 * (hallazgo de la review de Fase C): los endpoints de métricas anualizan
 * asumiendo puntos diarios (σ·√252, exponente 252/n en metrics-utils) —
 * alimentarles cierres semanales infla la volatilidad ~2,2x y convierte
 * el retorno total en "anualizado". El downsampling es SOLO para pintar.
 */
export function computeEvolution(
  instruments: EngineInstrument[],
  priceHistories: PriceHistories,
  transactions: EngineTransaction[],
  options: { downsample?: boolean } = {}
): EvolutionDataPoint[] {
  const firstTxDate = transactions.length > 0 ? transactions[0].tradeDate : null;
  const sortedDates = collectSortedDates(priceHistories, firstTxDate);
  const filledHistories = forwardFillHistories(instruments, priceHistories, sortedDates);
  const evolution = replayEvolution(instruments, filledHistories, transactions, sortedDates);
  return options.downsample === false ? evolution : downsampleWeekly(evolution);
}

// ============================================
// CONVERSIÓN A DIVISA BASE (Fase E.3) — paso PREVIO, puro
// ============================================

/** Tabla de tipos + divisa base de la cartera (o del dashboard) */
export type EngineFx = { base: string; table: FxTable };

export type EngineFxResult = {
  instruments: EngineInstrument[];
  priceHistories: PriceHistories;
  transactions: EngineTransaction[];
  /** Cobertura por instrumento: los no convertidos van en su divisa (y se declaran) */
  coverage: FxCoverage;
};

const needsConversion = (currency: string | undefined, base: string) =>
  currency !== undefined && normalizeCurrency(currency).code !== normalizeCurrency(base).code;

/**
 * Convierte las ENTRADAS del motor a la divisa base, sin tocar el motor:
 *
 * - precios diarios de cada instrumento al tipo DE ESE DÍA
 * - `pricePerShare` de cada transacción al tipo de su `tradeDate`
 * - fallback `avgCost` (antes del primer precio) → `avgCostBase` si existe;
 *   si no, el avgCost convertido al tipo de la última fecha con precio
 *
 * Consecuencia buscada (decisión 2a): el valor y el TWR en divisa base
 * INCLUYEN el efecto divisa — una acción en USD que sube un 5% mientras el
 * dólar cae un 8% pierde dinero para un inversor en euros.
 *
 * Política de huecos (2d): lo que no se puede convertir se deja en su
 * divisa y el instrumento sale en `coverage.missing`; nunca se trata como
 * si ya estuviera en base sin decirlo. Las transacciones de instrumentos
 * sin posición actual no se convierten (el motor las salta enteras).
 */
export function applyFxToEngineInputs(
  instruments: EngineInstrument[],
  priceHistories: PriceHistories,
  transactions: EngineTransaction[],
  fx: EngineFx
): EngineFxResult {
  const currencyOf = new Map(instruments.map((i) => [i.instrumentId, i.currency]));
  const failed = new Set<string>();

  // Última fecha con precio (para convertir el fallback sin avgCostBase)
  let lastDate = "";
  for (const map of priceHistories.values()) {
    for (const date of map.keys()) if (date > lastDate) lastDate = date;
  }

  const histories: PriceHistories = new Map();
  for (const [instrumentId, prices] of priceHistories) {
    const currency = currencyOf.get(instrumentId);
    if (!needsConversion(currency, fx.base)) {
      histories.set(instrumentId, prices);
      continue;
    }
    const converted = new Map<string, number>();
    for (const [date, price] of prices) {
      const r = convert(price, currency!, fx.base, date, fx.table);
      if (!r.converted) failed.add(instrumentId);
      converted.set(date, r.value);
    }
    histories.set(instrumentId, converted);
  }

  const convertedTransactions = transactions.map((tx) => {
    const currency = currencyOf.get(tx.instrumentId);
    if (!needsConversion(currency, fx.base)) return tx;
    const r = convert(tx.pricePerShare, currency!, fx.base, tx.tradeDate, fx.table);
    if (!r.converted) failed.add(tx.instrumentId);
    return { ...tx, pricePerShare: r.value };
  });

  const convertedInstruments = instruments.map((inst) => {
    if (!needsConversion(inst.currency, fx.base)) return inst;
    if (inst.avgCostBase != null) return { ...inst, avgCost: inst.avgCostBase };
    const r = convert(inst.avgCost, inst.currency!, fx.base, lastDate, fx.table);
    if (!r.converted) failed.add(inst.instrumentId);
    return { ...inst, avgCost: r.value };
  });

  const coverage = coverageReport(
    instruments.map((inst) => ({
      label: inst.label ?? inst.instrumentId,
      currency: normalizeCurrency(inst.currency ?? fx.base).code,
      converted: !failed.has(inst.instrumentId),
    }))
  );

  return { instruments: convertedInstruments, priceHistories: histories, transactions: convertedTransactions, coverage };
}
