/**
 * Elección del listado por divisa en la importación — Fase E.7 (punto 0)
 *
 * Fixtures: respuestas REALES de Yahoo (search + meta.currency de /chart)
 * sondeadas el 09-oct-2026.
 */
import { describe, it, expect } from "vitest";
import { chooseListingByCurrency, MAX_LISTING_CANDIDATES } from "./listing-choice";

/** Lookup falso que registra qué símbolos se consultaron */
function fakeLookup(table: Record<string, string | null>) {
  const calls: string[] = [];
  const getCurrency = async (symbol: string) => {
    calls.push(symbol);
    return table[symbol] ?? null;
  };
  return { calls, getCurrency };
}

// FR0013416716 (Amundi Physical Gold ETC): el caso que originó C1
const GOLD = [{ symbol: "GOLD.AS" }, { symbol: "FR0013416716.SG" }, { symbol: "AMGOLDN.MX" }];
const GOLD_FX = { "GOLD.AS": "USD", "FR0013416716.SG": "EUR", "AMGOLDN.MX": "MXN" };

describe("chooseListingByCurrency", () => {
  it("salta el primer listado si su divisa no es la del CSV (GOLD.AS en USD → .SG en EUR)", async () => {
    const { calls, getCurrency } = fakeLookup(GOLD_FX);
    const choice = await chooseListingByCurrency(GOLD, "EUR", getCurrency);
    expect(choice).toEqual({ candidate: GOLD[1], currency: "EUR", match: "matched" });
    // Para en cuanto coincide: no pregunta por el tercero
    expect(calls).toEqual(["GOLD.AS", "FR0013416716.SG"]);
  });

  it("si el primero ya coincide, cuesta una sola consulta", async () => {
    const { calls, getCurrency } = fakeLookup({ "EIMI.L": "USD" });
    const choice = await chooseListingByCurrency([{ symbol: "EIMI.L" }], "USD", getCurrency);
    expect(choice?.match).toBe("matched");
    expect(choice?.candidate.symbol).toBe("EIMI.L");
    expect(calls).toEqual(["EIMI.L"]);
  });

  it("ninguno coincide: el primero, marcado para revisión, con SU divisa (IGLN.L en USD frente a un CSV en EUR)", async () => {
    const { calls, getCurrency } = fakeLookup({ "IGLN.L": "USD" });
    const choice = await chooseListingByCurrency([{ symbol: "IGLN.L" }], "EUR", getCurrency);
    expect(choice).toEqual({ candidate: { symbol: "IGLN.L" }, currency: "USD", match: "mismatch" });
    expect(calls).toEqual(["IGLN.L"]);
  });

  it("ninguno coincide entre varios: vuelve al primero y conserva su divisa, no la del último consultado", async () => {
    const { getCurrency } = fakeLookup(GOLD_FX);
    const choice = await chooseListingByCurrency(GOLD, "CHF", getCurrency);
    expect(choice).toEqual({ candidate: GOLD[0], currency: "USD", match: "mismatch" });
  });

  it("la fila sin divisa mantiene el comportamiento anterior (el primero) sin marcarlo", async () => {
    const { calls, getCurrency } = fakeLookup(GOLD_FX);
    for (const rowCurrency of [undefined, null, "", "  "]) {
      const choice = await chooseListingByCurrency(GOLD, rowCurrency, getCurrency);
      expect(choice).toEqual({ candidate: GOLD[0], currency: "USD", match: "unknown" });
    }
    expect(calls).toEqual(["GOLD.AS", "GOLD.AS", "GOLD.AS", "GOLD.AS"]);
  });

  it("normaliza las dos divisas: GBp del listado casa con GBP del CSV; minúsculas y espacios del CSV", async () => {
    const { getCurrency } = fakeLookup({ "TLW.L": "GBp" });
    const a = await chooseListingByCurrency([{ symbol: "TLW.L" }], "GBP", getCurrency);
    expect(a).toEqual({ candidate: { symbol: "TLW.L" }, currency: "GBP", match: "matched" });
    const { getCurrency: g2 } = fakeLookup(GOLD_FX);
    const b = await chooseListingByCurrency(GOLD, " eur ", g2);
    expect(b?.candidate.symbol).toBe("FR0013416716.SG");
  });

  it("un listado sin divisa conocida no coincide nunca (no se adivina) y se sigue buscando", async () => {
    const { getCurrency } = fakeLookup({ "A.X": null, "B.Y": "EUR" });
    const choice = await chooseListingByCurrency([{ symbol: "A.X" }, { symbol: "B.Y" }], "EUR", getCurrency);
    expect(choice?.candidate.symbol).toBe("B.Y");
    const { getCurrency: g2 } = fakeLookup({});
    const none = await chooseListingByCurrency([{ symbol: "A.X" }], "EUR", g2);
    expect(none).toEqual({ candidate: { symbol: "A.X" }, currency: null, match: "mismatch" });
  });

  it("examina como mucho MAX_LISTING_CANDIDATES candidatos", async () => {
    const many = Array.from({ length: MAX_LISTING_CANDIDATES + 3 }, (_, i) => ({ symbol: `S${i}` }));
    const table = Object.fromEntries(many.map((c) => [c.symbol, "USD"]));
    table[`S${MAX_LISTING_CANDIDATES + 1}`] = "EUR"; // fuera del límite
    const { calls, getCurrency } = fakeLookup(table);
    const choice = await chooseListingByCurrency(many, "EUR", getCurrency);
    expect(choice?.match).toBe("mismatch");
    expect(calls).toHaveLength(MAX_LISTING_CANDIDATES);
  });

  it("sin candidatos: null", async () => {
    const { getCurrency } = fakeLookup({});
    expect(await chooseListingByCurrency([], "EUR", getCurrency)).toBeNull();
  });
});
