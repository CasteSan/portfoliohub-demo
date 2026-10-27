/**
 * Agregación del TER (coste anual de los fondos) — Fase D.5 (funciones PURAS)
 *
 * Coste anual estimado de una cartera = Σ (valor_posición_i × TER_i) sobre
 * fondos y ETFs; las acciones (y demás tipos sin gastos corrientes) cuentan
 * 0 y se consideran SIEMPRE cubiertas. La COBERTURA es visible por diseño:
 * si falta el TER de parte del patrimonio, la UI lo declara ("calculado
 * sobre el X% de tu cartera") — un agregado parcial que calla su cobertura
 * es una cifra que miente.
 */

/** Posición mínima para agregar TER (valores ya en number) */
export type TERPosition = {
  /** Valor de mercado de la posición (shares × precio actual o avgCost) */
  marketValue: number;
  /** Tipo del instrumento: solo FUND y ETF llevan TER */
  typeId: string;
  /** TER en tanto por uno (0.0013 = 0,13%), o null si no hay dato */
  expenseRatio: number | null;
};

export type PortfolioTER = {
  /** Σ valor × TER de los fondos/ETFs CON dato, en €/año */
  annualCost: number;
  /** Valor total de la cartera */
  totalValue: number;
  /** Valor con coste conocido: no-fondos (TER 0) + fondos/ETFs con TER */
  coveredValue: number;
  /** coveredValue / totalValue × 100 (0 si la cartera está vacía) */
  coveragePercent: number;
  /** annualCost / totalValue × 100 — el "Y% del patrimonio" de la card */
  costPercentOfPortfolio: number;
  /** Nº de fondos/ETFs con TER */
  fundsWithTER: number;
  /** Nº de fondos/ETFs SIN TER (los que degradan la cobertura) */
  fundsMissingTER: number;
};

/** Tipos de instrumento que llevan gastos corrientes (TER) */
const TER_BEARING_TYPES = new Set(["FUND", "ETF"]);

export function aggregatePortfolioTER(positions: TERPosition[]): PortfolioTER {
  let annualCost = 0;
  let totalValue = 0;
  let coveredValue = 0;
  let fundsWithTER = 0;
  let fundsMissingTER = 0;

  for (const pos of positions) {
    const value = Number.isFinite(pos.marketValue) ? pos.marketValue : 0;
    totalValue += value;

    if (!TER_BEARING_TYPES.has(pos.typeId)) {
      // Acciones, ETC, etc.: sin gastos corrientes → coste 0, cubierto
      coveredValue += value;
      continue;
    }

    if (pos.expenseRatio !== null && Number.isFinite(pos.expenseRatio)) {
      annualCost += value * pos.expenseRatio;
      coveredValue += value;
      fundsWithTER += 1;
    } else {
      fundsMissingTER += 1;
    }
  }

  return {
    annualCost,
    totalValue,
    coveredValue,
    coveragePercent: totalValue > 0 ? (coveredValue / totalValue) * 100 : 0,
    costPercentOfPortfolio: totalValue > 0 ? (annualCost / totalValue) * 100 : 0,
    fundsWithTER,
    fundsMissingTER,
  };
}

/**
 * Regla anti-placeholder de Yahoo (gate D.5, decidido con la sonda D.0.3):
 * Yahoo devuelve `annualReportExpenseRatio.raw = 0` EXACTO para todo el
 * universo de fondos europeos — es un placeholder, no un TER real (SPY sí
 * devuelve su 0,09%). Un 0 de Yahoo NUNCA se persiste: no rompería nada
 * visualmente (suma 0€) pero inflaría la cobertura aparente con un dato
 * inventado — la mentira silenciosa que D quiere evitar.
 *
 * @param raw - valor crudo de feesExpensesInvestment.annualReportExpenseRatio.raw
 * @returns TER en tanto por uno solo si es un número finito ESTRICTAMENTE > 0
 */
export function sanitizeYahooTER(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}
