/**
 * Utilidades de divisa — Fase E (funciones PURAS)
 *
 * - Normalización de subunidades (E.1, frontera del proveedor Yahoo)
 * - Tabla de tipos del BCE y conversión con forward-fill acotado (E.2)
 *
 * MODO PROFESOR — Convención del BCE y cruces
 * El BCE publica cuántas unidades de cada divisa vale 1 EUR (USD 1,1177 =
 * 1 € compra 1,1177 $). Con esa tabla se convierte entre CUALQUIER par
 * pasando por el euro: de USD a CAD = importe / tasa(USD) × tasa(CAD). Es
 * como calibrar todos los espectros contra la misma estrella estándar en vez
 * de cada uno contra cada otro: N series en lugar de N² pares.
 *
 * MODO PROFESOR — ¿Por qué "GBp" no es una divisa?
 * Algunas bolsas cotizan en la SUBUNIDAD de la moneda: Londres en peniques
 * (Yahoo lo marca "GBp" o "GBX"), Johannesburgo en céntimos de rand ("ZAc"),
 * Tel Aviv en agorot ("ILA"). Un precio de 1.488 GBp son 14,88 £. Si se
 * guardara tal cual con etiqueta GBP, valoraría la posición ×100 — es el
 * caso de `TLW.L` que detectó la sonda E.0.3. Se normaliza UNA vez, en la
 * frontera del proveedor, y el resto de la app solo ve divisas ISO.
 * Es como calibrar unidades al leer el FITS: después del pipeline todo está
 * en la misma unidad física.
 */

/** Subunidades conocidas de Yahoo → divisa ISO y factor a aplicar al precio */
const MINOR_UNITS: Record<string, { code: string; factor: number }> = {
  GBp: { code: "GBP", factor: 0.01 },
  GBX: { code: "GBP", factor: 0.01 },
  ZAc: { code: "ZAR", factor: 0.01 },
  ZAC: { code: "ZAR", factor: 0.01 },
  ILA: { code: "ILS", factor: 0.01 },
};

/**
 * Normaliza un código de divisa de proveedor a ISO 4217.
 *
 * @returns `code` ISO y `factor` por el que multiplicar los importes
 *   (0,01 para subunidades, 1 en el resto). Códigos vacíos → EUR (la divisa
 *   de la mayoría del universo; quien llame decide si avisar).
 *   OJO: "GBp" y "GBP" se distinguen por mayúsculas — no se normaliza el case
 *   antes de mirar la tabla.
 */
export function normalizeCurrency(raw: string | null | undefined): {
  code: string;
  factor: number;
} {
  if (!raw) return { code: "EUR", factor: 1 };
  const minor = MINOR_UNITS[raw];
  if (minor) return minor;
  return { code: raw.toUpperCase(), factor: 1 };
}

// ============================================
// TABLA DE TIPOS Y CONVERSIÓN (E.2)
// ============================================

/** Divisa en la que el BCE expresa sus tipos (1 EUR = rate × divisa) */
export const FX_PIVOT = "EUR";

/**
 * Días máximos de forward-fill: el BCE no publica fines de semana ni
 * festivos TARGET (el hueco más largo medido desde 2021 es de 5 días,
 * Semana Santa — sonda E.0.5). Más allá, el tipo NO se inventa.
 */
export const FX_MAX_FILL_DAYS = 7;

/** Un tipo publicado: unidades de la divisa por 1 EUR en `date` (yyyy-mm-dd) */
export type FxPoint = { date: string; rate: number };

/** divisa ISO → serie de tipos ordenada por fecha ascendente */
export type FxTable = Map<string, FxPoint[]>;

/** Fila tal como sale de la BD o del proveedor (rate admite Prisma Decimal) */
export type FxRow = { date: Date | string; quote: string; rate: unknown };

const toDateKey = (d: Date | string): string =>
  typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);

/** Días entre dos fechas yyyy-mm-dd (b − a) */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Construye la tabla a partir de filas sueltas: agrupa por divisa, descarta
 * tipos no positivos o no numéricos, ordena y deja una fila por fecha.
 */
export function buildFxTable(rows: FxRow[]): FxTable {
  const byCurrency = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const rate = Number(row.rate);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    const currency = row.quote.toUpperCase();
    const series = byCurrency.get(currency) ?? new Map<string, number>();
    series.set(toDateKey(row.date), rate);
    byCurrency.set(currency, series);
  }
  const table: FxTable = new Map();
  for (const [currency, series] of byCurrency) {
    table.set(
      currency,
      [...series.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, rate]) => ({ date, rate }))
    );
  }
  return table;
}

/**
 * Tipo vigente de una divisa en una fecha: el último publicado en esa fecha
 * o antes, si no tiene más de FX_MAX_FILL_DAYS días. EUR siempre vale 1.
 * Búsqueda binaria: la tabla de 5 años tiene ~1.500 puntos por divisa.
 *
 * @returns null si la divisa no está en la tabla, la fecha es anterior al
 *   primer tipo o el último tipo es demasiado viejo
 */
export function rateOn(
  table: FxTable,
  currency: string,
  date: string
): { rate: number; rateDate: string } | null {
  const code = currency.toUpperCase();
  if (code === FX_PIVOT) return { rate: 1, rateDate: date };
  const series = table.get(code);
  if (!series || series.length === 0) return null;

  let lo = 0;
  let hi = series.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= date) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  const point = series[found];
  if (daysBetween(point.date, date) > FX_MAX_FILL_DAYS) return null;
  return { rate: point.rate, rateDate: point.date };
}

export type ConversionResult = {
  /** Importe en la divisa destino; si `converted` es false, el ORIGINAL */
  value: number;
  /** false = falta tipo: el importe NO está en la divisa destino */
  converted: boolean;
  /** Fecha del tipo usado (el más antiguo de las dos patas); null si identidad o sin tipo */
  rateDate: string | null;
};

/**
 * Convierte un importe entre divisas con el tipo del día (cruce vía EUR).
 *
 * - Subunidades (GBp) se normalizan antes: 1.488 GBp → 14,88 GBP → …
 * - Misma divisa → identidad (converted = true, sin tipo).
 * - Sin tipo para alguna pata → `converted: false` y el importe ORIGINAL:
 *   la política de huecos de la decisión 2d — nunca identidad silenciosa;
 *   quien llama lo declara en la cobertura.
 */
export function convert(
  amount: number,
  from: string,
  to: string,
  date: string,
  table: FxTable
): ConversionResult {
  const src = normalizeCurrency(from);
  const dst = normalizeCurrency(to);
  const base = amount * src.factor;
  if (src.code === dst.code) {
    return { value: base / dst.factor, converted: true, rateDate: null };
  }
  const rFrom = rateOn(table, src.code, date);
  const rTo = rateOn(table, dst.code, date);
  if (!rFrom || !rTo) return { value: amount, converted: false, rateDate: null };

  const legs = [src.code === FX_PIVOT ? null : rFrom.rateDate, dst.code === FX_PIVOT ? null : rTo.rateDate]
    .filter((d): d is string => d !== null)
    .sort();
  return {
    value: ((base / rFrom.rate) * rTo.rate) / dst.factor,
    converted: true,
    rateDate: legs[0] ?? null,
  };
}

/** Elemento para el informe de cobertura de una respuesta */
export type CoverageItem = { label: string; currency: string; converted: boolean };

export type FxCoverage = {
  /** Proporción de elementos convertidos (1 = todo en la divisa base) */
  coverage: number;
  /** Elementos sin tipo, sin repetir (para el caveat de la UI, copy #1) */
  missing: Array<{ instrument: string; currency: string }>;
};

/** Cobertura de una conversión: cuántos se convirtieron y cuáles faltan */
export function coverageReport(items: CoverageItem[]): FxCoverage {
  if (items.length === 0) return { coverage: 1, missing: [] };
  const seen = new Set<string>();
  const missing: FxCoverage["missing"] = [];
  let converted = 0;
  for (const item of items) {
    if (item.converted) {
      converted++;
      continue;
    }
    const key = `${item.label}|${item.currency}`;
    if (!seen.has(key)) {
      seen.add(key);
      missing.push({ instrument: item.label, currency: item.currency });
    }
  }
  return { coverage: converted / items.length, missing };
}

/**
 * Fecha del tipo vigente en `date` para un conjunto de divisas: la más
 * antigua de las patas (para "al cambio del DD/MM"). null si todas son la
 * divisa base o ninguna tiene tipo.
 */
export function fxAsOf(table: FxTable, currencies: string[], base: string, date: string): string | null {
  const baseCode = normalizeCurrency(base).code;
  let oldest: string | null = null;
  for (const currency of new Set(currencies.map((c) => normalizeCurrency(c).code))) {
    if (currency === baseCode) continue;
    for (const leg of [currency, baseCode]) {
      if (leg === FX_PIVOT) continue;
      const r = rateOn(table, leg, date);
      if (r && (!oldest || r.rateDate < oldest)) oldest = r.rateDate;
    }
  }
  return oldest;
}
