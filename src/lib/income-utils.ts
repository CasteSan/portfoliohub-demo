/**
 * Agregación de ingresos por dividendos — Fase D.4 (funciones PURAS)
 *
 * Patrón de `aggregate-tax-summary` pero POR CARTERA: la vista fiscal global
 * ya agrupa dividendos por año/país para todas las carteras del usuario;
 * aquí se agrupan los de UNA cartera por año y por instrumento.
 *
 * REGLA DEL BRUTO (idéntica a aggregate-tax-summary y buildSignedCashflows —
 * criterio de aceptación de D.4: cero divergencia con la vista fiscal):
 *   bruto = grossAmount, o totalAmount si el registro antiguo no lo separó
 *   retención = withholdingTax, o 0 si no hay
 *   neto = bruto − retención
 *
 * Punto único de intercepción para la conversión FX de la Fase E: con `fx`,
 * bruto y retención se convierten a la divisa base al tipo de la fecha del
 * dividendo (y el yield TTM queda en base, como el valor de la cartera).
 */

import { convert, coverageReport, type FxCoverage, type FxTable } from "@/lib/fx-utils";

/** Divisa base + tabla de tipos (Fase E) */
export type IncomeFx = { base: string; table: FxTable };

/** Transacción DIVIDEND mínima (admite Prisma Decimal vía Number()) */
export type DividendSourceTransaction = {
  tradeDate: Date;
  instrumentId: string;
  grossAmount: unknown | null;
  withholdingTax: unknown | null;
  totalAmount: unknown;
  /** Divisa del instrumento (Fase E); sin ella se asume la base */
  currency?: string;
};

export type YearlyIncome = {
  year: number;
  gross: number;
  withholding: number;
  net: number;
  count: number;
};

export type InstrumentIncome = {
  instrumentId: string;
  gross: number;
  withholding: number;
  net: number;
  count: number;
};

/** Bruto y retención de un DIVIDEND con la regla canónica (ver cabecera) */
function dividendAmounts(
  tx: DividendSourceTransaction,
  fx?: IncomeFx
): {
  gross: number;
  withholding: number;
  converted: boolean;
} {
  const gross =
    tx.grossAmount !== null && tx.grossAmount !== undefined
      ? Number(tx.grossAmount)
      : Number(tx.totalAmount ?? 0);
  const withholding =
    tx.withholdingTax !== null && tx.withholdingTax !== undefined
      ? Number(tx.withholdingTax)
      : 0;
  if (!fx) return { gross, withholding, converted: true };
  const date = tx.tradeDate.toISOString().split("T")[0];
  const from = tx.currency ?? fx.base;
  const g = convert(gross, from, fx.base, date, fx.table);
  const w = convert(withholding, from, fx.base, date, fx.table);
  return { gross: g.value, withholding: w.value, converted: g.converted && w.converted };
}

/**
 * Cobertura FX de los dividendos (Fase E): cuáles no se pudieron convertir
 * a la divisa base. Para el caveat de cobertura de la vista (copy #1).
 */
export function dividendCoverage(
  transactions: DividendSourceTransaction[],
  fx: IncomeFx,
  labelOf: (instrumentId: string) => string = (id) => id
): FxCoverage {
  return coverageReport(
    transactions.map((tx) => ({
      label: labelOf(tx.instrumentId),
      currency: tx.currency ?? fx.base,
      converted: dividendAmounts(tx, fx).converted,
    }))
  );
}

/** Dividendos agrupados por año natural, ordenados ASC por año */
export function aggregateDividendsByYear(
  transactions: DividendSourceTransaction[],
  fx?: IncomeFx
): YearlyIncome[] {
  const byYear = new Map<number, YearlyIncome>();

  for (const tx of transactions) {
    const year = tx.tradeDate.getFullYear();
    const { gross, withholding } = dividendAmounts(tx, fx);
    const entry =
      byYear.get(year) ?? { year, gross: 0, withholding: 0, net: 0, count: 0 };
    entry.gross += gross;
    entry.withholding += withholding;
    entry.net = entry.gross - entry.withholding;
    entry.count += 1;
    byYear.set(year, entry);
  }

  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

/**
 * Dividendos de UN año agrupados por instrumento, ordenados DESC por bruto
 * (el que más paga, primero).
 */
export function aggregateDividendsByInstrument(
  transactions: DividendSourceTransaction[],
  year: number,
  fx?: IncomeFx
): InstrumentIncome[] {
  const byInstrument = new Map<string, InstrumentIncome>();

  for (const tx of transactions) {
    if (tx.tradeDate.getFullYear() !== year) continue;
    const { gross, withholding } = dividendAmounts(tx, fx);
    const entry =
      byInstrument.get(tx.instrumentId) ??
      { instrumentId: tx.instrumentId, gross: 0, withholding: 0, net: 0, count: 0 };
    entry.gross += gross;
    entry.withholding += withholding;
    entry.net = entry.gross - entry.withholding;
    entry.count += 1;
    byInstrument.set(tx.instrumentId, entry);
  }

  return [...byInstrument.values()].sort((a, b) => b.gross - a.gross);
}

/**
 * Yield REALIZADO de los últimos 12 meses: dividendos BRUTOS cobrados en la
 * ventana (hoy − 365 días, hoy] dividido por el valor actual de la cartera.
 *
 * Definición mostrada en la UI (decisión de D.4): NO es el dividendYield
 * forward de Yahoo — es lo que la cartera pagó de verdad el último año
 * sobre lo que vale hoy.
 *
 * @returns tanto por uno (0.021 = 2,1%), o null si no hay dividendos en la
 *   ventana o el valor actual no es positivo (sin base, no se inventa)
 */
export function realizedYieldTTM(
  transactions: DividendSourceTransaction[],
  currentValue: number,
  today: Date,
  fx?: IncomeFx
): number | null {
  if (!Number.isFinite(currentValue) || currentValue <= 0) return null;

  const windowStart = new Date(today);
  windowStart.setDate(windowStart.getDate() - 365);

  let grossTTM = 0;
  let count = 0;
  for (const tx of transactions) {
    if (tx.tradeDate > windowStart && tx.tradeDate <= today) {
      grossTTM += dividendAmounts(tx, fx).gross;
      count += 1;
    }
  }

  if (count === 0) return null;
  return grossTTM / currentValue;
}
