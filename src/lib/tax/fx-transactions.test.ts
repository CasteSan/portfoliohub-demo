/**
 * Fiscal en divisa base — Fase E.6
 *
 * Fixture derivado a mano (USD por 1 EUR del BCE, redondeados para el cálculo):
 *   BUY  10 × 100 $ + 1 $ comisión el 02-ene-2025, EURUSD 1,08
 *   SELL 10 × 100 $ − 1 $ comisión el 01-oct-2025, EURUSD 1,146
 * En dólares: 999 − 1.001 = −2 $ (casi tablas).
 * En euros (regla AEAT, cada operación a SU tipo):
 *   coste    = 1.001 / 1,08  = 926,851852 €
 *   ingreso  =   999 / 1,146 = 871,727749 €
 *   pérdida  = −55,124103 €   ← el dólar cayó un 6%: es una pérdida REAL en euros
 * Convertir "la plusvalía en $ al tipo de hoy" daría −1,745201 € (incorrecto).
 */
import { describe, it, expect } from "vitest";
import { toBaseCurrencyTransactions } from "./fx-transactions";
import { calculatePortfolioFIFO } from "./fifo-engine";
import { buildFxTable } from "@/lib/fx-utils";

const fx = {
  base: "EUR",
  table: buildFxTable([
    { date: "2025-01-02", quote: "USD", rate: 1.08 },
    { date: "2025-10-01", quote: "USD", rate: 1.146 },
  ]),
};

const usdTrades = [
  { id: "b1", instrumentId: "BRK", type: "BUY", shares: 10, pricePerShare: 100, fees: 1, tradeDate: new Date("2025-01-02T00:00:00Z"), currency: "USD", taxMetadata: null },
  { id: "s1", instrumentId: "BRK", type: "SELL", shares: 10, pricePerShare: 100, fees: 1, tradeDate: new Date("2025-10-01T00:00:00Z"), currency: "USD", taxMetadata: null },
];

describe("toBaseCurrencyTransactions", () => {
  it("convierte precio y comisión al tipo de la fecha de cada operación; shares y fechas intactos", () => {
    const { transactions } = toBaseCurrencyTransactions(usdTrades, fx);
    expect(transactions[0].pricePerShare).toBeCloseTo(100 / 1.08, 10);
    expect(transactions[0].fees).toBeCloseTo(1 / 1.08, 10);
    expect(transactions[1].pricePerShare).toBeCloseTo(100 / 1.146, 10);
    expect(transactions[1].shares).toBe(10);
    expect(transactions[1].tradeDate).toBe(usdTrades[1].tradeDate);
    expect(transactions[1].instrumentId).toBe("BRK");
  });

  it("plusvalía en EUR derivada a mano: −55,124103 € (no −1,75 € = −2 $ al tipo de hoy)", () => {
    const { transactions } = toBaseCurrencyTransactions(usdTrades, fx);
    const gain = calculatePortfolioFIFO(transactions).get("BRK")!.realizedGains[0];
    expect(gain.costBasis).toBeCloseTo(926.851852, 6);
    expect(gain.saleProceeds).toBeCloseTo(871.727749, 6);
    expect(gain.gain).toBeCloseTo(-55.124103, 6);
  });

  it("operaciones en EUR: idénticas (el FIFO da exactamente lo mismo que sin conversión)", () => {
    const eur = usdTrades.map((t) => ({ ...t, currency: "EUR" }));
    const { transactions, coverage } = toBaseCurrencyTransactions(eur, fx);
    expect(transactions.map((t) => [t.pricePerShare, t.fees])).toEqual([[100, 1], [100, 1]]);
    expect(calculatePortfolioFIFO(transactions).get("BRK")!.realizedGains[0].gain).toBe(
      calculatePortfolioFIFO(eur).get("BRK")!.realizedGains[0].gain
    );
    expect(coverage).toEqual({ coverage: 1, missing: [] });
  });

  it("dividendo en USD: bruto y retención al tipo de su fecha", () => {
    const div = { tradeDate: new Date("2025-10-01T00:00:00Z"), currency: "USD", pricePerShare: 0, fees: 0, grossAmount: 11.46, withholdingTax: 1.719 };
    const [out] = toBaseCurrencyTransactions([div], fx).transactions;
    expect(out.grossAmount).toBeCloseTo(10, 10);
    expect(out.withholdingTax).toBeCloseTo(1.5, 10);
  });

  it("traspaso con coste arrastrado en base (E.2): se usa tal cual, sin revaluar", () => {
    const tin = {
      tradeDate: new Date("2025-10-01T00:00:00Z"), currency: "USD", pricePerShare: 108, fees: 0,
      taxMetadata: { transferType: "traspaso_fondos", fiscalCostDragged: 108, fiscalCostDraggedBase: 100 },
    };
    expect(toBaseCurrencyTransactions([tin], fx).transactions[0].taxMetadata!.fiscalCostDragged).toBe(100);
  });

  it("traspaso antiguo sin coste en base: se convierte al tipo del día del traspaso", () => {
    const tin = {
      tradeDate: new Date("2025-10-01T00:00:00Z"), currency: "USD", pricePerShare: 114.6, fees: 0,
      taxMetadata: { fiscalCostDragged: 114.6 },
    };
    expect(toBaseCurrencyTransactions([tin], fx).transactions[0].taxMetadata!.fiscalCostDragged).toBeCloseTo(100, 10);
  });

  it("sin tipo (JPY): importes en su divisa y cobertura declarada", () => {
    const yen = { ...usdTrades[0], currency: "JPY", label: "7203.T" };
    const { transactions, coverage } = toBaseCurrencyTransactions([yen], fx);
    expect(transactions[0].pricePerShare).toBe(100);
    expect(coverage).toEqual({ coverage: 0, missing: [{ instrument: "7203.T", currency: "JPY" }] });
  });
});
