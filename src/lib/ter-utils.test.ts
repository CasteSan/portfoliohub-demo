/**
 * Tests de ter-utils — Fase D.5
 *
 * Expectativas derivadas a mano. Incluye la regla anti-placeholder de Yahoo
 * (gate D.5: un 0 exacto de Yahoo jamás se persiste) y los casos del plan:
 * cobertura parcial, cartera sin fondos, TER 0 legítimo.
 */
import { describe, it, expect } from "vitest";
import {
  aggregatePortfolioTER,
  sanitizeYahooTER,
  type TERPosition,
} from "@/lib/ter-utils";

describe("aggregatePortfolioTER", () => {
  it("Σ valor × TER sobre fondos/ETFs; las acciones cuentan 0 y siempre cubren", () => {
    const positions: TERPosition[] = [
      { marketValue: 50000, typeId: "FUND", expenseRatio: 0.0013 }, // 65 €/año
      { marketValue: 10000, typeId: "ETF", expenseRatio: 0.0025 }, // 25 €/año
      { marketValue: 20000, typeId: "STOCK", expenseRatio: null }, // 0, cubierta
    ];
    const result = aggregatePortfolioTER(positions);

    expect(result.annualCost).toBeCloseTo(90, 10); // 65 + 25
    expect(result.totalValue).toBe(80000);
    expect(result.coveredValue).toBe(80000);
    expect(result.coveragePercent).toBeCloseTo(100, 10);
    // 90 / 80000 = 0,1125%
    expect(result.costPercentOfPortfolio).toBeCloseTo(0.1125, 10);
    expect(result.fundsWithTER).toBe(2);
    expect(result.fundsMissingTER).toBe(0);
  });

  it("cobertura PARCIAL: el fondo sin TER degrada la cobertura, no el coste", () => {
    const positions: TERPosition[] = [
      { marketValue: 60000, typeId: "FUND", expenseRatio: 0.001 }, // 60 €/año
      { marketValue: 40000, typeId: "FUND", expenseRatio: null }, // sin dato
    ];
    const result = aggregatePortfolioTER(positions);

    expect(result.annualCost).toBeCloseTo(60, 10);
    expect(result.coveredValue).toBe(60000);
    expect(result.coveragePercent).toBeCloseTo(60, 10);
    expect(result.fundsMissingTER).toBe(1);
  });

  it("cartera sin fondos (solo acciones): coste 0, cobertura 100%", () => {
    const result = aggregatePortfolioTER([
      { marketValue: 5000, typeId: "STOCK", expenseRatio: null },
      { marketValue: 3000, typeId: "STOCK", expenseRatio: null },
    ]);

    expect(result.annualCost).toBe(0);
    expect(result.coveragePercent).toBeCloseTo(100, 10);
    expect(result.fundsWithTER).toBe(0);
    expect(result.fundsMissingTER).toBe(0);
  });

  it("TER 0 LEGÍTIMO (persistido explícitamente): cuenta como cubierto con coste 0", () => {
    // Distinto del placeholder de Yahoo: si un TER 0 llegó a la BD es porque
    // una fuente lo dio de verdad (p.ej. clase institucional bonificada)
    const result = aggregatePortfolioTER([
      { marketValue: 10000, typeId: "FUND", expenseRatio: 0 },
    ]);

    expect(result.annualCost).toBe(0);
    expect(result.coveragePercent).toBeCloseTo(100, 10);
    expect(result.fundsWithTER).toBe(1);
  });

  it("cartera vacía: todo a 0, sin divisiones por cero", () => {
    const result = aggregatePortfolioTER([]);
    expect(result).toEqual({
      annualCost: 0,
      totalValue: 0,
      coveredValue: 0,
      coveragePercent: 0,
      costPercentOfPortfolio: 0,
      fundsWithTER: 0,
      fundsMissingTER: 0,
    });
  });

  it("caso de la sonda D.0.3 (números reales): ~561 €/año sobre 122.599 € en fondos", () => {
    // Los 5 mayores fondos con TER de la sonda (valor prod × TER Morningstar):
    //   Groupama 52.814 × 0,13% = 68,66 · Neuberger 13.872 × 0,25% = 34,68
    //   Pictet China 7.518 × 0,68% = 51,12 · Carmignac 6.765 × 1,20% = 81,18
    //   B&H 6.590 × 0,72% = 47,45   → Σ = 283,09 €/año
    const result = aggregatePortfolioTER([
      { marketValue: 52814, typeId: "FUND", expenseRatio: 0.0013 },
      { marketValue: 13872, typeId: "FUND", expenseRatio: 0.0025 },
      { marketValue: 7518, typeId: "FUND", expenseRatio: 0.0068 },
      { marketValue: 6765, typeId: "FUND", expenseRatio: 0.012 },
      { marketValue: 6590, typeId: "FUND", expenseRatio: 0.0072 },
    ]);
    expect(result.annualCost).toBeCloseTo(
      52814 * 0.0013 + 13872 * 0.0025 + 7518 * 0.0068 + 6765 * 0.012 + 6590 * 0.0072,
      10
    );
    expect(result.annualCost).toBeCloseTo(283.09, 1);
  });
});

describe("sanitizeYahooTER — regla anti-placeholder (gate D.5)", () => {
  it("un valor real > 0 pasa (SPY: 0.000945 = 0,09%)", () => {
    expect(sanitizeYahooTER(0.000945)).toBe(0.000945);
  });

  it("el 0 EXACTO de Yahoo es placeholder → null, jamás se persiste", () => {
    expect(sanitizeYahooTER(0)).toBeNull();
  });

  it("negativos, NaN, Infinity, undefined, strings → null", () => {
    expect(sanitizeYahooTER(-0.001)).toBeNull();
    expect(sanitizeYahooTER(NaN)).toBeNull();
    expect(sanitizeYahooTER(Infinity)).toBeNull();
    expect(sanitizeYahooTER(undefined)).toBeNull();
    expect(sanitizeYahooTER("0.002")).toBeNull();
  });
});
