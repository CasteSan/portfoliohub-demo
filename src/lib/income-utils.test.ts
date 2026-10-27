/**
 * Tests de income-utils — Fase D.4
 *
 * Expectativas derivadas a mano. El fixture "forma real de la BD" replica
 * los DIVIDEND existentes (gross_amount NULL, total_amount relleno) — la
 * regla del bruto debe coincidir con aggregate-tax-summary (criterio de
 * aceptación: cero divergencia con la vista fiscal).
 */
import { describe, it, expect } from "vitest";
import {
  aggregateDividendsByYear,
  aggregateDividendsByInstrument,
  realizedYieldTTM,
  type DividendSourceTransaction,
  dividendCoverage,
} from "@/lib/income-utils";
import { buildFxTable } from "@/lib/fx-utils";

const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** Dividendo moderno: bruto y retención separados */
const div = (
  iso: string,
  instrumentId: string,
  gross: number,
  withholding: number
): DividendSourceTransaction => ({
  tradeDate: d(iso),
  instrumentId,
  grossAmount: gross,
  withholdingTax: withholding,
  totalAmount: gross,
});

/** Dividendo con la FORMA REAL de la BD: gross NULL → fallback totalAmount */
const legacyDiv = (
  iso: string,
  instrumentId: string,
  total: number
): DividendSourceTransaction => ({
  tradeDate: d(iso),
  instrumentId,
  grossAmount: null,
  withholdingTax: null,
  totalAmount: total,
});

describe("aggregateDividendsByYear", () => {
  it("agrupa por año natural con bruto, retención y neto", () => {
    const result = aggregateDividendsByYear([
      div("2024-03-10", "A", 100, 15),
      div("2024-09-12", "A", 120, 18),
      div("2025-03-11", "B", 200, 30),
    ]);

    expect(result).toEqual([
      { year: 2024, gross: 220, withholding: 33, net: 187, count: 2 },
      { year: 2025, gross: 200, withholding: 30, net: 170, count: 1 },
    ]);
  });

  it("retención 0 (forma real de la BD): neto = bruto, sin inventar retenciones", () => {
    // Los 5 DIVIDEND reales: gross NULL, withholding NULL, total = shares×precio
    const result = aggregateDividendsByYear([
      legacyDiv("2025-01-20", "A", 9.23),
      legacyDiv("2025-02-14", "B", 2.31),
      legacyDiv("2025-04-01", "B", 2.49),
      legacyDiv("2025-06-05", "C", 1.52),
      legacyDiv("2025-07-01", "D", 0.86),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].year).toBe(2025);
    // 9.23 + 2.31 + 2.49 + 1.52 + 0.86 = 16.41 (el total de la sonda D.0.2,
    // que coincide con la vista fiscal global — misma regla de bruto)
    expect(result[0].gross).toBeCloseTo(16.41, 10);
    expect(result[0].withholding).toBe(0);
    expect(result[0].net).toBeCloseTo(16.41, 10);
    expect(result[0].count).toBe(5);
  });

  it("array vacío → [] (el estado vacío lo decide la UI, no el agregador)", () => {
    expect(aggregateDividendsByYear([])).toEqual([]);
  });

  it("años no consecutivos: solo aparecen los años con dividendos, ordenados ASC", () => {
    const result = aggregateDividendsByYear([
      div("2026-01-05", "A", 50, 0),
      div("2022-06-01", "A", 30, 0),
    ]);
    expect(result.map((r) => r.year)).toEqual([2022, 2026]);
  });
});

describe("aggregateDividendsByInstrument", () => {
  const txs = [
    div("2025-02-01", "A", 40, 6),
    div("2025-05-01", "A", 60, 9),
    div("2025-08-01", "B", 200, 30),
    div("2024-08-01", "B", 999, 0), // otro año: fuera
  ];

  it("agrupa el año pedido por instrumento, DESC por bruto", () => {
    const result = aggregateDividendsByInstrument(txs, 2025);
    expect(result).toEqual([
      { instrumentId: "B", gross: 200, withholding: 30, net: 170, count: 1 },
      { instrumentId: "A", gross: 100, withholding: 15, net: 85, count: 2 },
    ]);
  });

  it("año sin dividendos → []", () => {
    expect(aggregateDividendsByInstrument(txs, 2023)).toEqual([]);
  });
});

describe("realizedYieldTTM — yield realizado últimos 12 meses", () => {
  const today = d("2026-07-12");

  it("suma los BRUTOS de la ventana de 365 días y divide por el valor actual", () => {
    // 210 brutos en ventana / 10.000 = 2,1%
    const yieldTTM = realizedYieldTTM(
      [
        div("2026-01-10", "A", 110, 20),
        div("2025-09-01", "A", 100, 15),
        div("2024-06-01", "A", 999, 0), // fuera de ventana
      ],
      10000,
      today
    );
    expect(yieldTTM).toBeCloseTo(0.021, 12);
  });

  it("frontera de la ventana: hace exactamente 365 días queda FUERA; hoy queda dentro", () => {
    // windowStart = 2025-07-12; la condición es tradeDate > windowStart
    expect(
      realizedYieldTTM([div("2025-07-12", "A", 100, 0)], 10000, today)
    ).toBeNull();
    expect(
      realizedYieldTTM([div("2025-07-13", "A", 100, 0)], 10000, today)
    ).toBeCloseTo(0.01, 12);
    expect(
      realizedYieldTTM([div("2026-07-12", "A", 100, 0)], 10000, today)
    ).toBeCloseTo(0.01, 12);
  });

  it("dividendos futuros (importados con fecha posterior a hoy) no cuentan", () => {
    expect(
      realizedYieldTTM([div("2026-08-01", "A", 100, 0)], 10000, today)
    ).toBeNull();
  });

  it("sin dividendos en la ventana → null (la UI oculta el yield, no muestra 0%)", () => {
    expect(realizedYieldTTM([], 10000, today)).toBeNull();
    expect(
      realizedYieldTTM([div("2023-01-01", "A", 100, 0)], 10000, today)
    ).toBeNull();
  });

  it("valor actual no positivo → null (sin base, no se inventa)", () => {
    const txs = [div("2026-01-10", "A", 100, 0)];
    expect(realizedYieldTTM(txs, 0, today)).toBeNull();
    expect(realizedYieldTTM(txs, -5, today)).toBeNull();
    expect(realizedYieldTTM(txs, NaN, today)).toBeNull();
  });
});

// ============================================
// Fase E.3 — dividendos en divisa base
// ============================================
// USD por 1 EUR: 2025-07-09 → 1,17 · 2025-10-08 → 1,16 (redondos para el cálculo)
//   UNH 1,52 $ bruto el 09-jul-25 → 1,52 / 1,17 = 1,299145 €
//   CRM 2,86 $ bruto, 0,43 $ retención el 08-oct-25 → 2,465517 € / 0,370690 €
describe("ingresos con fx (E.3)", () => {
  const fx = {
    base: "EUR",
    table: buildFxTable([
      { date: "2025-07-09", quote: "USD", rate: 1.17 },
      { date: "2025-10-08", quote: "USD", rate: 1.16 },
    ]),
  };
  const unh = { tradeDate: new Date("2025-07-09T00:00:00Z"), instrumentId: "UNH", grossAmount: 1.52, withholdingTax: null, totalAmount: 1.52, currency: "USD" };
  const crm = { tradeDate: new Date("2025-10-08T00:00:00Z"), instrumentId: "CRM", grossAmount: 2.86, withholdingTax: 0.43, totalAmount: 2.43, currency: "USD" };
  const san = { tradeDate: new Date("2025-10-08T00:00:00Z"), instrumentId: "SAN", grossAmount: 5, withholdingTax: 0.95, totalAmount: 4.05, currency: "EUR" };

  it("por año: cada dividendo al tipo de SU fecha", () => {
    const [y2025] = aggregateDividendsByYear([unh, crm, san], fx);
    expect(y2025.gross).toBeCloseTo(1.52 / 1.17 + 2.86 / 1.16 + 5, 6);
    expect(y2025.withholding).toBeCloseTo(0.43 / 1.16 + 0.95, 6);
    expect(y2025.net).toBeCloseTo(y2025.gross - y2025.withholding, 10);
  });

  it("por instrumento: CRM 2,465517 € bruto", () => {
    const rows = aggregateDividendsByInstrument([unh, crm, san], 2025, fx);
    expect(rows.find((r) => r.instrumentId === "CRM")!.gross).toBeCloseTo(2.465517, 6);
  });

  it("yield TTM en base sobre el valor en base", () => {
    const y = realizedYieldTTM([crm], 1000, new Date("2026-01-01T00:00:00Z"), fx);
    expect(y).toBeCloseTo(2.86 / 1.16 / 1000, 10);
  });

  it("sin fx: los mismos importes de siempre (en su divisa)", () => {
    expect(aggregateDividendsByYear([unh])[0].gross).toBe(1.52);
  });

  it("cobertura: un dividendo en divisa sin tipos se declara", () => {
    const yen = { ...unh, instrumentId: "7203.T", currency: "JPY" };
    const cov = dividendCoverage([unh, yen], fx);
    expect(cov.coverage).toBe(0.5);
    expect(cov.missing).toEqual([{ instrument: "7203.T", currency: "JPY" }]);
  });
});
