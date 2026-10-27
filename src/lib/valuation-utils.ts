/**
 * Valoración spot de posiciones en la divisa base — Fase E.3 (PURA)
 *
 * Sustituye a la fórmula `shares × (currentPrice ?? avgCost)` que estaba
 * repetida en 10 sitios (hallazgo 6 del plan) y que sumaba dólares y euros
 * como si fueran lo mismo.
 *
 * - VALOR: valor nativo convertido al tipo de HOY (`date`, con el
 *   forward-fill de ≤7 días de fx-utils: el último tipo publicado).
 * - APORTADO: `shares × avgCostBase` — el coste a los tipos del día de cada
 *   compra (decisión 2c). Así el "Aportado" de las vistas spot coincide con
 *   el del motor de evolución, que convierte cada transacción a su fecha:
 *   una sola verdad. Sin avgCostBase (posición manual en divisa extranjera,
 *   sin transacciones), el coste se convierte al tipo de hoy.
 * - Lo que no se puede convertir se suma en su divisa y se declara en la
 *   cobertura (decisión 2d): la UI muestra el caveat, nunca lo calla.
 */

import { convert, coverageReport, normalizeCurrency, type FxCoverage, type FxTable } from "@/lib/fx-utils";

/** Posición mínima (los campos numéricos admiten Prisma Decimal vía Number()) */
export type ValuationInput = {
  shares: unknown;
  avgCost: unknown;
  avgCostBase?: unknown | null;
  currentPrice?: unknown | null;
  /** Divisa del instrumento */
  currency: string;
  /** Etiqueta para la cobertura (ticker o nombre) */
  label: string;
};

export type ValuedPosition = {
  /** Valor de mercado en la divisa base (o nativo si `converted` es false) */
  value: number;
  /** Coste (aportado) en la divisa base (o nativo si `converted` es false) */
  invested: number;
  /** Los mismos importes en la divisa del instrumento (para la fila, regla 2e) */
  valueNative: number;
  investedNative: number;
  currency: string;
  /** false = falta tipo: value/invested siguen en la divisa del instrumento */
  converted: boolean;
  /** Fecha del tipo usado (null si misma divisa) — para "al cambio del DD/MM" */
  rateDate: string | null;
};

export type PortfolioValuation = {
  positions: ValuedPosition[];
  totalValue: number;
  totalInvested: number;
  /** Fecha del tipo más antiguo usado (null si todo estaba en la divisa base) */
  asOf: string | null;
  coverage: FxCoverage;
};

export type ValuationFx = {
  base: string;
  table: FxTable;
  /** Fecha de la valoración (yyyy-mm-dd): hoy */
  date: string;
};

const num = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

/** Valora posiciones en la divisa base. Pura. */
export function valuePositions(positions: ValuationInput[], fx: ValuationFx): PortfolioValuation {
  const base = normalizeCurrency(fx.base).code;
  let totalValue = 0;
  let totalInvested = 0;
  let asOf: string | null = null;

  const valued = positions.map((p): ValuedPosition => {
    const shares = num(p.shares);
    const avgCost = num(p.avgCost);
    const price = p.currentPrice !== null && p.currentPrice !== undefined ? num(p.currentPrice) : avgCost;
    const valueNative = shares * price;
    const investedNative = shares * avgCost;

    const v = convert(valueNative, p.currency, base, fx.date, fx.table);
    let invested: number;
    if (normalizeCurrency(p.currency).code === base) {
      invested = convert(investedNative, p.currency, base, fx.date, fx.table).value;
    } else if (p.avgCostBase !== null && p.avgCostBase !== undefined) {
      invested = shares * num(p.avgCostBase);
    } else {
      invested = v.converted ? convert(investedNative, p.currency, base, fx.date, fx.table).value : investedNative;
    }

    if (v.rateDate && (!asOf || v.rateDate < asOf)) asOf = v.rateDate;
    totalValue += v.value;
    totalInvested += invested;

    return {
      value: v.value,
      invested,
      valueNative,
      investedNative,
      currency: p.currency,
      converted: v.converted,
      rateDate: v.rateDate,
    };
  });

  return {
    positions: valued,
    totalValue,
    totalInvested,
    asOf,
    coverage: coverageReport(
      positions.map((p, i) => ({
        label: p.label,
        currency: normalizeCurrency(p.currency).code,
        converted: valued[i].converted,
      }))
    ),
  };
}

/** Bloque `fx` de las respuestas de la API (E.3.5) */
export type FxResponseInfo = {
  base: string;
  asOf: string | null;
  coverage: number;
  missing: FxCoverage["missing"];
};

export function fxResponseInfo(base: string, asOf: string | null, coverage: FxCoverage): FxResponseInfo {
  return { base, asOf, coverage: coverage.coverage, missing: coverage.missing };
}

/**
 * Divisa del dashboard global (decisión 1): si todas las carteras filtradas
 * comparten divisa base, esa; si no, EUR y la UI lo dice (copy #7).
 */
export function resolveDashboardBase(portfolioCurrencies: string[]): { base: string; mixed: boolean } {
  const codes = new Set(portfolioCurrencies.map((c) => normalizeCurrency(c).code));
  if (codes.size === 1) return { base: [...codes][0], mixed: false };
  return { base: "EUR", mixed: codes.size > 1 };
}
