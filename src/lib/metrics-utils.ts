/**
 * Métricas Avanzadas de Cartera — Funciones Puras
 *
 * MODO PROFESOR — ¿Qué son estas métricas?
 *
 * 1. TWR (Time-Weighted Return): Rendimiento de la cartera eliminando el efecto
 *    de los flujos de dinero. Si metes 10k y sube a 11k, tu TWR es +10%,
 *    independientemente de cuándo hayas metido el dinero.
 *
 * 2. Volatilidad anualizada: Mide cuánto "sube y baja" tu cartera día a día.
 *    Se calcula como la desviación estándar de los retornos diarios × √252
 *    (252 = días de trading en un año). Cuanto mayor, más riesgo.
 *
 * 3. Max Drawdown: La mayor caída desde un pico hasta un valle.
 *    Si tu cartera valía 10k, bajó a 8k y luego subió a 12k,
 *    el max drawdown fue -20% (de 10k a 8k).
 *
 * 4. Sharpe Ratio: ¿Cuánto rendimiento obtienes por cada unidad de riesgo?
 *    Sharpe = (Rendimiento - Tasa libre de riesgo) / Volatilidad
 *    > 1.0 es bueno, > 2.0 es muy bueno, < 0.5 es mediocre.
 */

import { convert, type FxTable } from "@/lib/fx-utils";

export type EvolutionPoint = {
  date: string;
  value: number;
  invested: number;
  /**
   * Flujo externo neto acumulado a precios de transacción (lo emite
   * evolution-engine desde la micro-fase fix-twr-cashflows). Opcional para
   * fixtures/series legadas: sin él, el cashflow cae a Δinvested (correcto
   * solo cuando no hay ventas — ver intervalReturn).
   */
  cumFlow?: number;
};

export type PortfolioMetrics = {
  twr: number;
  twrAnnualized: number;
  volatility: number;
  maxDrawdown: number;
  sharpe: number;
  tradingDays: number;
  xirr: number | null;
};

export type CashflowEntry = {
  date: string; // YYYY-MM-DD
  amount: number; // negativo = inversión, positivo = retirada
  /** Solo con fx (Fase E): false si faltó el tipo y el importe sigue en su divisa */
  converted?: boolean;
};

/**
 * Transacción mínima para construir la serie de cashflows del XIRR.
 * Los campos monetarios admiten Prisma Decimal (Number() los convierte) —
 * los endpoints pasan las filas de la query tal cual.
 */
export type CashflowSourceTransaction = {
  tradeDate: Date;
  type: string; // "BUY" | "SELL" | "TRANSFER_IN" | "TRANSFER_OUT" | "DIVIDEND"
  shares: unknown;
  pricePerShare: unknown;
  /** Comisiones de la operación (default 0 en el schema) */
  fees?: unknown;
  /** Solo DIVIDEND: bruto antes de retención (null → fallback totalAmount) */
  grossAmount?: unknown | null;
  /** Solo DIVIDEND: retención en origen (null → 0) */
  withholdingTax?: unknown | null;
  /** Importe total registrado (fallback del bruto en DIVIDEND antiguos) */
  totalAmount?: unknown;
  /** Divisa del instrumento (Fase E): los importes van en ella (convención verificada en E.0.3) */
  currency?: string;
};

/**
 * Serie de cashflows FIRMADOS para el XIRR — el "dinero de verdad" que salió
 * de tu bolsillo o volvió a él (extraída en la micro-fase fix-twr-cashflows;
 * ampliada en D.1 con fees y dividendos para que el MWR mostrado como "tu
 * rentabilidad real" sea exactamente eso).
 *
 * Semántica por tipo:
 *   BUY/TRANSFER_IN  → −(shares × precio + fees)  comprar cuesta base MÁS comisión
 *   SELL/TRANSFER_OUT → +(shares × precio − fees)  vender ingresa base MENOS comisión
 *   DIVIDEND         → +neto = bruto − retención   (bruto = grossAmount, o
 *                      totalAmount si el registro antiguo no lo separó —
 *                      MISMA regla que aggregate-tax-summary, cero divergencia
 *                      con la vista fiscal)
 *
 * Punto único de intercepción para la conversión FX de la Fase E: con `fx`,
 * cada flujo se convierte a la divisa base AL TIPO DE SU FECHA (el MWR en
 * euros de quien compró en dólares incluye el efecto divisa). Sin `fx`, el
 * comportamiento es el de siempre.
 */
export function buildSignedCashflows(
  transactions: CashflowSourceTransaction[],
  fx?: { base: string; table: FxTable }
): CashflowEntry[] {
  const entries = transactions.map((tx) => {
    const date = tx.tradeDate.toISOString().split("T")[0];

    if (tx.type === "DIVIDEND") {
      const gross =
        tx.grossAmount !== null && tx.grossAmount !== undefined
          ? Number(tx.grossAmount)
          : Number(tx.totalAmount ?? 0);
      const withholding =
        tx.withholdingTax !== null && tx.withholdingTax !== undefined
          ? Number(tx.withholdingTax)
          : 0;
      return { date, amount: gross - withholding };
    }

    const base = Number(tx.shares) * Number(tx.pricePerShare);
    const fees = Number(tx.fees ?? 0);
    const isInflow = tx.type === "BUY" || tx.type === "TRANSFER_IN";
    return {
      date,
      // inversión = negativo; las comisiones SIEMPRE restan a tu favor:
      // encarecen la compra y recortan los ingresos de la venta
      amount: isInflow ? -(base + fees) : base - fees,
    };
  });

  if (!fx) return entries;
  return entries.map((entry, i) => {
    const r = convert(entry.amount, transactions[i].currency ?? fx.base, fx.base, entry.date, fx.table);
    return { date: entry.date, amount: r.value, converted: r.converted };
  });
}

const TRADING_DAYS_PER_YEAR = 252;
const MIN_DATA_POINTS = 5;

/** Entrada mínima de intervalReturn (EvolutionPoint y DataPoint del chart encajan) */
export type IntervalPoint = {
  value: number;
  invested?: number;
  cumFlow?: number;
};

/**
 * Retorno del subperiodo prev → curr — el helper ÚNICO del TWR
 * (micro-fase fix-twr-cashflows):
 *
 *   sub_return = (value_curr − cashflow − value_prev) / value_prev
 *
 * CASHFLOW DEL INTERVALO: Δ cumFlow (flujo externo neto acumulado a precios
 * de transacción, emitido por evolution-engine) si AMBOS puntos lo traen.
 * Fallback legado: Δ invested — equivalente SOLO cuando no hay ventas (una
 * venta retira de invested el coste medio, no los ingresos reales, y la
 * plusvalía realizada aparecía como pérdida fantasma: el bug que motiva
 * esta micro-fase). Al ser ambos ACUMULADOS, el Δ entre dos puntos no
 * adyacentes (serie diezmada, o empalme tras filtrar ceros) sigue siendo
 * la suma de los flujos intermedios — no hace falta re-agregar nada.
 *
 * POLÍTICA DE CEROS (única; antes cada consumidor divergía):
 * con prev.value <= 0 no hay base sobre la que medir → null, y el llamador
 * decide: calculateTWR/calculateVolatility saltan el intervalo,
 * normalizePortfolioTWR filtra los ceros de la serie ANTES (y el empalme
 * queda correcto gracias al Δ acumulado), enrichWithTWR conserva el punto
 * y arrastra el acumulado.
 */
export function intervalReturn(
  prev: IntervalPoint,
  curr: IntervalPoint
): number | null {
  if (prev.value <= 0) return null;

  const cashflow =
    prev.cumFlow !== undefined && curr.cumFlow !== undefined
      ? curr.cumFlow - prev.cumFlow
      : (curr.invested ?? 0) - (prev.invested ?? 0);

  return (curr.value - cashflow - prev.value) / prev.value;
}

/**
 * TWR: Time-Weighted Return
 *
 * Encadena los sub-retornos de intervalReturn: TWR = Π(1 + r_i) − 1.
 * Los intervalos sin base (prev.value <= 0 → null) no encadenan.
 */
function calculateTWR(data: EvolutionPoint[]): number {
  let cumulativeReturn = 1;

  for (let i = 1; i < data.length; i++) {
    const subReturn = intervalReturn(data[i - 1], data[i]);
    if (subReturn === null) continue;

    cumulativeReturn *= 1 + subReturn;
  }

  return cumulativeReturn - 1;
}

/**
 * TWR normalizado a base 100 — serie diaria
 *
 * MODO PROFESOR — ¿Por qué no vale value / value[0] * 100?
 * Si metes 10k€ nuevos en tu cartera, el valor sube 10k€ pero eso NO es
 * rendimiento del mercado. La normalización simple cuenta depósitos como
 * ganancia, haciendo que tu cartera "aplaste" al benchmark en la comparación.
 *
 * Esta función usa la misma fórmula TWR que calculateTWR() arriba, pero en
 * vez de devolver solo el valor final, devuelve TODA la serie intermedia.
 * Cada punto es: 100 × Π(1 + return_i) hasta ese día.
 *
 * Resultado: una curva base 100 que sube/baja solo por rendimiento real,
 * sin inflarse con aportaciones ni desinflarse con retiradas.
 *
 * @param data - Array de {date, value, invested} de la evolution API
 * @returns Serie base 100 con TWR diario acumulado
 */
export function normalizePortfolioTWR(
  data: EvolutionPoint[]
): { date: string; value: number }[] {
  if (data.length === 0) return [];

  // Filtrar puntos con valor 0 al inicio (antes de la primera inversión)
  const validData = data.filter((d) => d.value > 0);
  if (validData.length === 0) return [];

  let cumulative = 1.0;
  const result: { date: string; value: number }[] = [
    { date: validData[0].date, value: 100 },
  ];

  for (let i = 1; i < validData.length; i++) {
    const curr = validData[i];

    const dailyReturn = intervalReturn(validData[i - 1], curr);
    /* v8 ignore next -- defensa inalcanzable: validData ya filtró value <= 0 arriba */
    cumulative *= 1 + (dailyReturn ?? 0);

    result.push({ date: curr.date, value: 100 * cumulative });
  }

  return result;
}

/**
 * Enriquece cada punto con el TWR acumulado hasta esa fecha (tooltip y header
 * del gráfico de evolución — antes vivía como copia privada en EvolutionPanel,
 * el 4º duplicado de la fórmula que unifica intervalReturn).
 *
 * A diferencia de calculateTWR/normalizePortfolioTWR, NO filtra los puntos
 * con value <= 0: la serie de display necesita un twr por CADA punto pintado,
 * así que los conserva y arrastra el acumulado (política de ceros del
 * docstring de intervalReturn).
 */
export function enrichWithTWR<T extends IntervalPoint>(
  raw: T[]
): (T & { twr: number })[] {
  let cumReturn = 1;
  return raw.map((point, i) => {
    if (i > 0) {
      const subReturn = intervalReturn(raw[i - 1], point);
      if (subReturn !== null) {
        cumReturn *= 1 + subReturn;
      }
    }
    return { ...point, twr: cumReturn - 1 };
  });
}

/**
 * Volatilidad anualizada (TWR-adjusted)
 *
 * MODO PROFESOR — ¿Por qué NO usar retornos simples value_t/value_{t-1}?
 * Si metes 5.000€ más en la cartera (compras), el valor sube de golpe.
 * El retorno simple interpreta eso como una subida de mercado → infla la
 * volatilidad artificialmente. La solución es restar los cashflows ANTES
 * de calcular el retorno, exactamente como hace el TWR (mismo helper:
 * intervalReturn, con el cashflow real Δ cumFlow).
 *
 * Así un depósito de 5.000€ NO cuenta como un "retorno" del +50%, y una
 * venta con plusvalía tampoco mete una "pérdida" fantasma en σ.
 */
function calculateVolatility(data: EvolutionPoint[]): number {
  const dailyReturns: number[] = [];

  for (let i = 1; i < data.length; i++) {
    const dailyReturn = intervalReturn(data[i - 1], data[i]);
    if (dailyReturn !== null) {
      dailyReturns.push(dailyReturn);
    }
  }

  if (dailyReturns.length < 2) return 0;

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) /
    (dailyReturns.length - 1);
  const stdDev = Math.sqrt(variance);

  return stdDev * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/**
 * Max Drawdown
 *
 * Recorre la serie de valores. Mantiene el pico máximo visto hasta ahora.
 * En cada punto, calcula la caída desde el pico.
 * Devuelve la mayor caída (número negativo o cero).
 */
function calculateMaxDrawdown(data: EvolutionPoint[]): number {
  let peak = -Infinity;
  let maxDrawdown = 0;

  for (const point of data) {
    if (point.value > peak) {
      peak = point.value;
    }
    if (peak > 0) {
      const drawdown = (point.value - peak) / peak;
      if (drawdown < maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
  }

  return maxDrawdown;
}

/**
 * Sharpe Ratio
 *
 * sharpe = (TWR_anualizado - risk_free_rate) / volatilidad_anualizada
 *
 * Si la volatilidad es 0, devuelve 0 (no hay riesgo, no tiene sentido).
 */
function calculateSharpe(
  twrAnnualized: number,
  volatility: number,
  riskFreeRate: number
): number {
  if (volatility === 0) return 0;
  return (twrAnnualized - riskFreeRate) / volatility;
}

/**
 * XIRR (Extended Internal Rate of Return) — MWR (Money-Weighted Return)
 *
 * MODO PROFESOR — ¿Qué es el XIRR?
 * Es la tasa de descuento r que hace que el NPV de todos los cashflows sea 0:
 *   NPV(r) = Σ(C_i / (1+r)^(d_i/365)) = 0
 *
 * A diferencia del TWR, el XIRR SÍ tiene en cuenta CUÁNDO metiste el dinero.
 * Si invertiste mucho justo antes de una subida, tu XIRR será alto.
 * Si invertiste justo antes de una caída, tu XIRR será bajo.
 *
 * Es como el TIR de Excel pero con fechas irregulares.
 * Usa Newton-Raphson para encontrar la raíz.
 *
 * @param cashflows - Array de {date, amount}: negativo = inversión, positivo = retirada
 * @param currentValue - Valor actual de la cartera (cashflow final positivo)
 * @param currentDate - Fecha actual (YYYY-MM-DD)
 * @returns XIRR anualizado o null si no converge
 */
export function calculateXIRR(
  cashflows: CashflowEntry[],
  currentValue: number,
  currentDate: string
): number | null {
  if (cashflows.length === 0 || currentValue <= 0) return null;

  // Añadir el valor actual como cashflow final positivo (como si vendieras todo hoy)
  const allCashflows = [
    ...cashflows,
    { date: currentDate, amount: currentValue },
  ];

  // Calcular días desde el primer cashflow
  const firstDate = new Date(allCashflows[0].date).getTime();
  const daysFromFirst = allCashflows.map(
    (cf) => (new Date(cf.date).getTime() - firstDate) / (1000 * 60 * 60 * 24)
  );

  // Newton-Raphson
  const MAX_ITERATIONS = 100;
  const TOLERANCE = 1e-7;
  let rate = 0.1; // Guess inicial: 10%

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let npv = 0;
    let dnpv = 0; // derivada del NPV respecto a r

    for (let i = 0; i < allCashflows.length; i++) {
      const t = daysFromFirst[i] / 365;
      const factor = Math.pow(1 + rate, t);

      if (!isFinite(factor) || factor === 0) {
        return null; // Divergencia
      }

      npv += allCashflows[i].amount / factor;
      dnpv -= (t * allCashflows[i].amount) / (factor * (1 + rate));
    }

    if (Math.abs(npv) < TOLERANCE) {
      return rate; // Convergió
    }

    if (Math.abs(dnpv) < 1e-10) {
      return null; // Derivada ~0, no puede avanzar
    }

    const newRate = rate - npv / dnpv;

    // Clamp: evitar que se vaya a valores absurdos
    if (newRate < -0.99) {
      rate = -0.99;
    } else if (newRate > 100) {
      rate = 100;
    } else {
      rate = newRate;
    }
  }

  return null; // No convergió
}

/**
 * Calcula todas las métricas de una sola vez.
 *
 * @param data - Array de puntos de evolución (mismo formato que la evolution API)
 * @param riskFreeRate - Tasa libre de riesgo anualizada (default 0)
 * @param cashflows - Cashflows para calcular XIRR (opcional)
 * @param currentValue - Valor actual para XIRR (opcional)
 * @param currentDate - Fecha actual para XIRR (opcional)
 * @returns Objeto con las métricas, o null si no hay suficientes datos
 */
export function calculatePortfolioMetrics(
  data: EvolutionPoint[],
  riskFreeRate: number = 0,
  cashflows?: CashflowEntry[],
  currentValue?: number,
  currentDate?: string
): PortfolioMetrics | null {
  // Filtrar puntos con valor 0 al inicio (antes de la primera inversión)
  const validData = data.filter((d) => d.value > 0);

  if (validData.length < MIN_DATA_POINTS) return null;

  const twr = calculateTWR(validData);
  const volatility = calculateVolatility(validData);
  const maxDrawdown = calculateMaxDrawdown(validData);

  // Anualizar TWR: (1 + TWR) ^ (252 / trading_days) - 1
  const tradingDays = validData.length;
  const twrAnnualized =
    tradingDays >= TRADING_DAYS_PER_YEAR
      ? Math.pow(1 + twr, TRADING_DAYS_PER_YEAR / tradingDays) - 1
      : twr; // Si menos de 1 año, mostrar TWR del periodo sin anualizar

  const sharpe = calculateSharpe(twrAnnualized, volatility, riskFreeRate);

  // Calcular XIRR si tenemos los datos necesarios
  let xirr: number | null = null;
  if (cashflows && currentValue !== undefined && currentDate) {
    xirr = calculateXIRR(cashflows, currentValue, currentDate);
  }

  return {
    twr,
    twrAnnualized,
    volatility,
    maxDrawdown,
    sharpe,
    tradingDays,
    xirr,
  };
}
