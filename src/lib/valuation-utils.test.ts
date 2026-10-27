/**
 * Valoración spot en divisa base — Fase E.3
 *
 * Tipos del BCE (divisa por 1 EUR): USD 1,1177 el 07-oct-2026 (miércoles),
 * GBP 0,84645. Casos derivados a mano:
 *   BRK-B: 2 acciones, avgCost 500,83 $, avgCostBase 434,7483 € (tipo de la
 *   compra, 1,1520), cotización 506,25 $ →
 *     valor   = 1.012,50 $ / 1,1177 = 905,878143 €
 *     aportado = 2 × 434,7483 = 869,4966 €   (NO 1.001,66 $ / 1,1177)
 */
import { describe, it, expect } from "vitest";
import { valuePositions, fxResponseInfo, resolveDashboardBase } from "./valuation-utils";
import { buildFxTable } from "./fx-utils";

const fx = {
  base: "EUR",
  date: "2026-10-08",
  table: buildFxTable([
    { date: "2026-10-07", quote: "USD", rate: 1.1177 },
    { date: "2026-10-07", quote: "GBP", rate: 0.84645 },
  ]),
};

const brk = { shares: 2, avgCost: 500.83, avgCostBase: 434.7483, currentPrice: 506.25, currency: "USD", label: "BRK-B" };
const fund = { shares: 100, avgCost: 9.5, avgCostBase: 9.5, currentPrice: 11.725, currency: "EUR", label: "FEPE.MU" };

describe("valuePositions", () => {
  it("posición en la divisa base: valor y aportado sin conversión", () => {
    const [p] = valuePositions([fund], fx).positions;
    expect(p.value).toBeCloseTo(1172.5, 10);
    expect(p.invested).toBeCloseTo(950, 10);
    expect(p).toMatchObject({ converted: true, rateDate: null, currency: "EUR" });
  });

  it("USD: valor al tipo de hoy (forward-fill del miércoles) y aportado con avgCostBase", () => {
    const [p] = valuePositions([brk], fx).positions;
    expect(p.value).toBeCloseTo(905.878143, 6);
    expect(p.invested).toBeCloseTo(869.4966, 6);
    expect(p.valueNative).toBeCloseTo(1012.5, 10);
    expect(p.investedNative).toBeCloseTo(1001.66, 10);
    expect(p.rateDate).toBe("2026-10-07");
  });

  it("USD sin avgCostBase (posición manual): aportado convertido al tipo de hoy", () => {
    const [p] = valuePositions([{ ...brk, avgCostBase: null }], fx).positions;
    expect(p.invested).toBeCloseTo(1001.66 / 1.1177, 6);
  });

  it("sin cotización: valora a coste (avgCost)", () => {
    const [p] = valuePositions([{ ...fund, currentPrice: null }], fx).positions;
    expect(p.value).toBeCloseTo(950, 10);
  });

  it("totales en EUR, fecha del tipo y cobertura completa", () => {
    const v = valuePositions([fund, brk], fx);
    expect(v.totalValue).toBeCloseTo(1172.5 + 905.878143, 5);
    expect(v.totalInvested).toBeCloseTo(950 + 869.4966, 5);
    expect(v.asOf).toBe("2026-10-07");
    expect(v.coverage).toEqual({ coverage: 1, missing: [] });
  });

  it("divisa sin tipos: suma en su divisa y la cobertura lo declara", () => {
    const yen = { shares: 10, avgCost: 2000, currentPrice: 2100, currency: "JPY", label: "7203.T" };
    const v = valuePositions([fund, yen], fx);
    expect(v.positions[1]).toMatchObject({ value: 21000, invested: 20000, converted: false });
    expect(v.coverage).toEqual({ coverage: 0.5, missing: [{ instrument: "7203.T", currency: "JPY" }] });
    expect(v.asOf).toBeNull();
  });

  it("peniques en cartera EUR: 1.488 GBp × 100 = 1.488 £ → 1.757,930 €", () => {
    const tlw = { shares: 100, avgCost: 1400, avgCostBase: null, currentPrice: 1488, currency: "GBp", label: "TLW.L" };
    const [p] = valuePositions([tlw], fx).positions;
    expect(p.value).toBeCloseTo(1488 / 0.84645, 6);
  });

  it("admite Decimal de Prisma y trata valores no numéricos como 0", () => {
    const dec = (v: number) => ({ valueOf: () => v, toString: () => String(v) });
    const [p] = valuePositions([{ ...fund, shares: dec(2), avgCost: dec(10), avgCostBase: dec(10), currentPrice: "abc" }], fx).positions;
    expect(p.value).toBe(0);
    expect(p.invested).toBe(20);
  });

  it("lista vacía: todo a cero, cobertura total", () => {
    expect(valuePositions([], fx)).toEqual({ positions: [], totalValue: 0, totalInvested: 0, asOf: null, coverage: { coverage: 1, missing: [] } });
  });
});

describe("fxResponseInfo", () => {
  it("forma del bloque fx de las respuestas", () => {
    expect(fxResponseInfo("EUR", "2026-10-07", { coverage: 1, missing: [] })).toEqual({
      base: "EUR", asOf: "2026-10-07", coverage: 1, missing: [],
    });
  });
});

describe("resolveDashboardBase", () => {
  it("todas las carteras en EUR → EUR sin caveat", () => {
    expect(resolveDashboardBase(["EUR", "EUR"])).toEqual({ base: "EUR", mixed: false });
  });
  it("todas en USD → USD", () => {
    expect(resolveDashboardBase(["USD"])).toEqual({ base: "USD", mixed: false });
  });
  it("mezcladas → EUR con caveat (copy #7); sin carteras → EUR", () => {
    expect(resolveDashboardBase(["EUR", "USD"])).toEqual({ base: "EUR", mixed: true });
    expect(resolveDashboardBase([])).toEqual({ base: "EUR", mixed: false });
  });
});
