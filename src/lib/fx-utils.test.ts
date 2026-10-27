/**
 * Tests de utilidades de divisa — Fase E (E.1: normalización; E.2 amplía)
 */
import { describe, it, expect } from "vitest";
import {
  normalizeCurrency,
  buildFxTable,
  rateOn,
  convert,
  coverageReport,
  FX_MAX_FILL_DAYS,
  fxAsOf,
} from "./fx-utils";

/**
 * Tabla pequeña con tipos realistas (convención BCE: divisa por 1 EUR).
 * 2026-10-02 es viernes, 03-04 fin de semana, 05 lunes, 07 miércoles.
 */
const table = buildFxTable([
  { date: "2026-10-02", quote: "USD", rate: 1.12 },
  { date: "2026-10-05", quote: "USD", rate: 1.118 },
  { date: "2026-10-07", quote: "USD", rate: 1.1177 },
  { date: "2026-10-05", quote: "CAD", rate: 1.6 },
  { date: "2026-10-07", quote: "CAD", rate: 1.59 },
  { date: "2026-10-07", quote: "GBP", rate: 0.84645 },
]);

describe("buildFxTable", () => {
  it("agrupa por divisa, ordena por fecha y normaliza el código a mayúsculas", () => {
    const t = buildFxTable([
      { date: "2026-10-07", quote: "usd", rate: 1.1177 },
      { date: new Date("2026-10-02T00:00:00Z"), quote: "USD", rate: 1.12 },
    ]);
    expect([...t.keys()]).toEqual(["USD"]);
    expect(t.get("USD")).toEqual([
      { date: "2026-10-02", rate: 1.12 },
      { date: "2026-10-07", rate: 1.1177 },
    ]);
  });

  it("acepta Decimal de Prisma (cualquier cosa que Number() entienda)", () => {
    const decimalLike = { toString: () => "1.1460", valueOf: () => 1.146 };
    expect(buildFxTable([{ date: "2026-09-18", quote: "USD", rate: decimalLike }]).get("USD")?.[0].rate).toBe(1.146);
  });

  it("descarta tipos no positivos o no numéricos y deja una fila por fecha (la última)", () => {
    const t = buildFxTable([
      { date: "2026-10-07", quote: "USD", rate: 0 },
      { date: "2026-10-06", quote: "USD", rate: -1 },
      { date: "2026-10-05", quote: "USD", rate: "abc" },
      { date: "2026-10-02", quote: "USD", rate: 1.1 },
      { date: "2026-10-02", quote: "USD", rate: 1.12 },
    ]);
    expect(t.get("USD")).toEqual([{ date: "2026-10-02", rate: 1.12 }]);
  });
});

describe("rateOn", () => {
  it("EUR siempre vale 1 (es la divisa pivote), en cualquier fecha", () => {
    expect(rateOn(table, "EUR", "1999-01-01")).toEqual({ rate: 1, rateDate: "1999-01-01" });
  });

  it("devuelve el tipo exacto del día publicado", () => {
    expect(rateOn(table, "USD", "2026-10-07")).toEqual({ rate: 1.1177, rateDate: "2026-10-07" });
  });

  it("fin de semana: forward-fill con el tipo del viernes", () => {
    expect(rateOn(table, "USD", "2026-10-04")).toEqual({ rate: 1.12, rateDate: "2026-10-02" });
  });

  it(`acepta hasta ${FX_MAX_FILL_DAYS} días de forward-fill y ni uno más`, () => {
    expect(rateOn(table, "GBP", "2026-10-14")?.rate).toBe(0.84645); // 7 días
    expect(rateOn(table, "GBP", "2026-10-15")).toBeNull(); // 8 días
  });

  it("fecha anterior al primer tipo, divisa desconocida → null", () => {
    expect(rateOn(table, "USD", "2026-10-01")).toBeNull();
    expect(rateOn(table, "JPY", "2026-10-07")).toBeNull();
  });

  it("el código de divisa no distingue mayúsculas", () => {
    expect(rateOn(table, "usd", "2026-10-07")?.rate).toBe(1.1177);
  });
});

describe("convert", () => {
  it("misma divisa: identidad, convertida, sin tipo", () => {
    expect(convert(123.45, "EUR", "EUR", "2026-10-07", table)).toEqual({ value: 123.45, converted: true, rateDate: null });
  });

  it("USD → EUR: 1.117,70 $ al 1,1177 son 1.000 €", () => {
    const r = convert(1117.7, "USD", "EUR", "2026-10-07", table);
    expect(r.value).toBeCloseTo(1000, 8);
    expect(r).toMatchObject({ converted: true, rateDate: "2026-10-07" });
  });

  it("EUR → USD: 100 € son 111,77 $", () => {
    expect(convert(100, "EUR", "USD", "2026-10-07", table).value).toBeCloseTo(111.77, 8);
  });

  it("cruce USD → CAD vía EUR: 111,77 $ → 100 € → 159 CA$", () => {
    const r = convert(111.77, "USD", "CAD", "2026-10-07", table);
    expect(r.value).toBeCloseTo(159, 8);
    expect(r.rateDate).toBe("2026-10-07");
  });

  it("cruce en un día sin tipo de ninguna: ambas patas del lunes; 1.118 $ → 1.600 CA$", () => {
    const r = convert(1118, "USD", "CAD", "2026-10-06", table);
    expect(r.value).toBeCloseTo(1600, 8);
    expect(r.rateDate).toBe("2026-10-05");
  });

  it("CAD → USD (cruce inverso): 159 CA$ → 111,77 $", () => {
    expect(convert(159, "CAD", "USD", "2026-10-07", table).value).toBeCloseTo(111.77, 8);
  });

  it("transacción en domingo usa el tipo del viernes: 112 $ → 100 €", () => {
    const r = convert(112, "USD", "EUR", "2026-10-04", table);
    expect(r.value).toBeCloseTo(100, 8);
    expect(r.rateDate).toBe("2026-10-02");
  });

  it("peniques: 1.488 GBp → 14,88 £ (identidad tras normalizar) → 17,579302 €", () => {
    expect(convert(1488, "GBp", "GBP", "2026-10-07", table)).toEqual({ value: 14.88, converted: true, rateDate: null });
    expect(convert(1488, "GBp", "EUR", "2026-10-07", table).value).toBeCloseTo(17.579302, 6);
  });

  it("hacia una subunidad: 10 € → 846,45 GBp", () => {
    expect(convert(10, "EUR", "GBp", "2026-10-07", table).value).toBeCloseTo(846.45, 8);
  });

  it("divisa sin tipos: NO convierte y devuelve el importe original (nunca identidad silenciosa)", () => {
    expect(convert(1000, "JPY", "EUR", "2026-10-07", table)).toEqual({ value: 1000, converted: false, rateDate: null });
  });

  it("hueco de más de 7 días: NO convierte", () => {
    expect(convert(100, "GBP", "EUR", "2026-10-20", table).converted).toBe(false);
  });

  it("falta la pata de destino (EUR → divisa sin tipo): NO convierte", () => {
    expect(convert(100, "EUR", "CHF", "2026-10-07", table)).toEqual({ value: 100, converted: false, rateDate: null });
  });
});

describe("coverageReport", () => {
  it("sin elementos: cobertura total", () => {
    expect(coverageReport([])).toEqual({ coverage: 1, missing: [] });
  });

  it("proporción convertida y lista de faltantes sin repetir", () => {
    const r = coverageReport([
      { label: "BRK-B", currency: "USD", converted: true },
      { label: "HIVE.V", currency: "CAD", converted: false },
      { label: "HIVE.V", currency: "CAD", converted: false },
      { label: "AMP.MC", currency: "EUR", converted: true },
    ]);
    expect(r.coverage).toBe(0.5);
    expect(r.missing).toEqual([{ instrument: "HIVE.V", currency: "CAD" }]);
  });
});

describe("normalizeCurrency", () => {
  it("peniques de Londres (GBp y GBX) → libras con factor 0,01", () => {
    expect(normalizeCurrency("GBp")).toEqual({ code: "GBP", factor: 0.01 });
    expect(normalizeCurrency("GBX")).toEqual({ code: "GBP", factor: 0.01 });
  });

  it("céntimos de rand y agorot → ZAR / ILS con factor 0,01", () => {
    expect(normalizeCurrency("ZAc")).toEqual({ code: "ZAR", factor: 0.01 });
    expect(normalizeCurrency("ILA")).toEqual({ code: "ILS", factor: 0.01 });
  });

  it("GBP (libras) NO es GBp: factor 1 — el case importa", () => {
    expect(normalizeCurrency("GBP")).toEqual({ code: "GBP", factor: 1 });
  });

  it("divisas ISO normales pasan tal cual (en mayúsculas)", () => {
    expect(normalizeCurrency("USD")).toEqual({ code: "USD", factor: 1 });
    expect(normalizeCurrency("cad")).toEqual({ code: "CAD", factor: 1 });
  });

  it("vacío o null → EUR (la mayoría del universo)", () => {
    expect(normalizeCurrency(null)).toEqual({ code: "EUR", factor: 1 });
    expect(normalizeCurrency("")).toEqual({ code: "EUR", factor: 1 });
  });
});

describe("fxAsOf", () => {
  it("fecha del tipo vigente (forward-fill) de las divisas extranjeras", () => {
    expect(fxAsOf(table, ["EUR", "USD"], "EUR", "2026-10-04")).toBe("2026-10-02");
  });
  it("la pata más antigua manda (USD del 07, CAD del 05 → 05)", () => {
    expect(fxAsOf(table, ["USD", "CAD"], "EUR", "2026-10-06")).toBe("2026-10-05");
  });
  it("todo en la divisa base o sin tipos → null", () => {
    expect(fxAsOf(table, ["EUR"], "EUR", "2026-10-07")).toBeNull();
    expect(fxAsOf(table, ["JPY"], "EUR", "2026-10-07")).toBeNull();
  });
  it("cartera en USD: la pata de la base también cuenta", () => {
    expect(fxAsOf(table, ["EUR"], "USD", "2026-10-04")).toBe("2026-10-02");
  });
});
