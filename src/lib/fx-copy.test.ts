/**
 * Textos de la conversión de divisas (copy #1, #2, #7 del plan de E)
 */
import { describe, it, expect } from "vitest";
import {
  approxBaseLine,
  approxCostLine,
  fxCoverageMessages,
  fxRatesLabel,
  listingCurrencyWarning,
  priceSourceLabel,
  shortRateDate,
} from "./fx-copy";

describe("fxCoverageMessages", () => {
  it("cobertura completa y sin mezcla: ningún aviso (el caveat #18 de D desaparece)", () => {
    expect(fxCoverageMessages([])).toEqual([]);
  });

  it("copy #1 en singular", () => {
    expect(fxCoverageMessages([{ instrument: "HIVE.V", currency: "CAD" }])).toEqual([
      "Sin tipo de cambio para 1 posición (HIVE.V, CAD); se muestra en su divisa.",
    ]);
  });

  it("copy #1 en plural", () => {
    expect(
      fxCoverageMessages([
        { instrument: "HIVE.V", currency: "CAD" },
        { instrument: "7203.T", currency: "JPY" },
      ])
    ).toEqual(["Sin tipo de cambio para 2 posiciones (HIVE.V, CAD; 7203.T, JPY); se muestran en su divisa."]);
  });

  it("copy #7 cuando el dashboard mezcla divisas", () => {
    expect(fxCoverageMessages([], true)).toEqual(["Carteras en distintas divisas: el total se muestra en euros."]);
  });
});

describe("approxBaseLine (copy #2)", () => {
  it("importe en euros con la fecha del tipo en DD/MM", () => {
    expect(approxBaseLine(12345.6, "EUR", "2026-09-18")).toMatch(/^≈ 12\.345,60\s€ al cambio del 18\/09$/);
  });

  it("sin fecha de tipo (misma divisa): solo el importe", () => {
    expect(approxBaseLine(905.878, "EUR", null)).toMatch(/^≈ 905,88\s€$/);
  });
});

describe("shortRateDate", () => {
  it("yyyy-mm-dd → DD/MM", () => {
    expect(shortRateDate("2026-10-07")).toBe("07/10");
  });
});

describe("approxCostLine (copy #2b, costes)", () => {
  it("coste en base con los tipos de cada compra", () => {
    expect(approxCostLine(869.4966, "EUR")).toMatch(/^≈ 869,50\s€ al cambio de cada compra$/);
  });
});

describe("priceSourceLabel (copy #4)", () => {
  it("Morningstar con la fecha del VL", () => {
    expect(priceSourceLabel("morningstar", "2026-09-17")).toBe("Precio de Morningstar (VL del 17/09)");
  });

  it("Morningstar sin fecha: solo la fuente", () => {
    expect(priceSourceLabel("morningstar", null)).toBe("Precio de Morningstar");
  });

  it("Yahoo: sin fecha (cotización del día)", () => {
    expect(priceSourceLabel("yahoo", "2026-09-17")).toBe("Precio de Yahoo Finance");
  });

  it("fuente desconocida o ausente: nada que pintar", () => {
    expect(priceSourceLabel(null, null)).toBeNull();
    expect(priceSourceLabel("cache", "2026-09-17")).toBeNull();
  });
});

describe("fxRatesLabel (copy #8)", () => {
  it("fecha del último tipo en DD/MM", () => {
    expect(fxRatesLabel("2026-10-08")).toBe("Tipos de cambio del 08/10");
  });
});

describe("listingCurrencyWarning (copy #9)", () => {
  it("con la divisa del listado", () => {
    expect(listingCurrencyWarning("IGLN.L", "USD", "EUR")).toBe(
      "La divisa del listado (IGLN.L, USD) no coincide con la de tu CSV (EUR): revísalo antes de importar."
    );
  });

  it("sin divisa conocida del listado", () => {
    expect(listingCurrencyWarning("X.Y", null, "EUR")).toBe(
      "No se pudo comprobar la divisa del listado (X.Y); tu CSV está en EUR: revísalo antes de importar."
    );
  });
});
