/**
 * Tests del registro de proveedores de precios — Fase E.1
 *
 * Proveedores FALSOS (sin red): verifican la prioridad por tipo, el fallback
 * ante null / excepción / precio inválido, el filtro de `supports()` y que
 * añadir un proveedor sea una entrada en la tabla de routing.
 */
import { describe, it, expect } from "vitest";
import { createRegistry, ROUTING, DEFAULT_ROUTE } from "./registry";
import type {
  HistoricalDataPoint,
  InstrumentRef,
  PriceProvider,
  PriceQuote,
} from "./types";

type FakeOptions = {
  supports?: (ref: InstrumentRef) => boolean;
  quote?: PriceQuote | null | Error;
  history?: HistoricalDataPoint[] | null | Error;
};

function fakeProvider(name: string, opts: FakeOptions = {}) {
  const calls: string[] = [];
  const provider: PriceProvider & { calls: string[] } = {
    name,
    calls,
    supports: opts.supports ?? (() => true),
    async getQuote(ref) {
      calls.push(`quote:${ref.id}`);
      if (opts.quote instanceof Error) throw opts.quote;
      return opts.quote === undefined ? null : opts.quote;
    },
    async getQuotes() {
      return new Map();
    },
    async getHistory(ref) {
      calls.push(`history:${ref.id}`);
      if (opts.history instanceof Error) throw opts.history;
      return opts.history === undefined ? null : opts.history;
    },
  };
  return provider;
}

const quote = (price: number, currency = "EUR"): PriceQuote => ({ price, currency, name: "x" });

const ref = (overrides: Partial<InstrumentRef> = {}): InstrumentRef => ({
  id: "inst-1",
  ticker: "0P0000TEST.F",
  isin: "LU0000000001",
  typeId: "FUND",
  currency: "EUR",
  ...overrides,
});

const points: HistoricalDataPoint[] = [
  { date: new Date("2026-10-06T00:00:00Z"), close: 10 },
  { date: new Date("2026-10-07T00:00:00Z"), close: 11 },
];

describe("ROUTING", () => {
  it("acciones e índices solo Yahoo; fondos, ETF y bonos Yahoo → Morningstar", () => {
    expect(ROUTING.STOCK).toEqual(["yahoo"]);
    expect(ROUTING.INDEX).toEqual(["yahoo"]);
    expect(ROUTING.FUND).toEqual(["yahoo", "morningstar"]);
    expect(ROUTING.ETF).toEqual(["yahoo", "morningstar"]);
    expect(ROUTING.BOND).toEqual(["yahoo", "morningstar"]);
    expect(DEFAULT_ROUTE).toEqual(["yahoo"]);
  });
});

describe("providersFor", () => {
  it("devuelve los proveedores de la ruta del tipo, en orden de prioridad", () => {
    const yahoo = fakeProvider("yahoo");
    const ms = fakeProvider("morningstar");
    const registry = createRegistry({ morningstar: ms, yahoo });
    expect(registry.providersFor(ref()).map((p) => p.name)).toEqual(["yahoo", "morningstar"]);
  });

  it("filtra con supports(): un fondo sin ticker cae directo a Morningstar", () => {
    const yahoo = fakeProvider("yahoo", { supports: (r) => Boolean(r.ticker) });
    const ms = fakeProvider("morningstar");
    const registry = createRegistry({ yahoo, morningstar: ms });
    expect(registry.providersFor(ref({ ticker: null })).map((p) => p.name)).toEqual(["morningstar"]);
  });

  it("un tipo sin entrada en ROUTING (REIT) usa la ruta por defecto: Yahoo", () => {
    const registry = createRegistry({ yahoo: fakeProvider("yahoo"), morningstar: fakeProvider("morningstar") });
    expect(registry.providersFor(ref({ typeId: "REIT" })).map((p) => p.name)).toEqual(["yahoo"]);
  });

  it("una acción nunca se pide a Morningstar aunque Morningstar diga que puede", () => {
    const registry = createRegistry({ yahoo: fakeProvider("yahoo"), morningstar: fakeProvider("morningstar") });
    expect(registry.providersFor(ref({ typeId: "STOCK" })).map((p) => p.name)).toEqual(["yahoo"]);
  });

  it("ignora nombres de la ruta que no están registrados", () => {
    const registry = createRegistry({ yahoo: fakeProvider("yahoo") });
    expect(registry.providersFor(ref()).map((p) => p.name)).toEqual(["yahoo"]);
  });
});

describe("getQuoteWithFallback", () => {
  it("con el primero sano, no consulta al segundo", async () => {
    const yahoo = fakeProvider("yahoo", { quote: quote(100) });
    const ms = fakeProvider("morningstar", { quote: quote(99) });
    const result = await createRegistry({ yahoo, morningstar: ms }).getQuoteWithFallback(ref());
    expect(result.quote?.price).toBe(100);
    expect(result.source).toBe("yahoo");
    expect(result.quote?.source).toBe("yahoo");
    expect(result.attempted).toEqual(["yahoo"]);
    expect(ms.calls).toHaveLength(0);
  });

  it("si el primero devuelve null, cae al segundo y lo etiqueta", async () => {
    const yahoo = fakeProvider("yahoo", { quote: null });
    const ms = fakeProvider("morningstar", { quote: quote(99) });
    const result = await createRegistry({ yahoo, morningstar: ms }).getQuoteWithFallback(ref());
    expect(result.quote?.price).toBe(99);
    expect(result.source).toBe("morningstar");
    expect(result.quote?.source).toBe("morningstar");
    expect(result.attempted).toEqual(["yahoo", "morningstar"]);
  });

  it("si el primero LANZA, el registro no lanza y cae al segundo", async () => {
    const yahoo = fakeProvider("yahoo", { quote: new Error("ENOTFOUND") });
    const ms = fakeProvider("morningstar", { quote: quote(99) });
    const result = await createRegistry({ yahoo, morningstar: ms }).getQuoteWithFallback(ref());
    expect(result.source).toBe("morningstar");
  });

  it("descarta precios no válidos (0, negativo, NaN) y sigue con el siguiente", async () => {
    for (const bad of [0, -5, Number.NaN]) {
      const yahoo = fakeProvider("yahoo", { quote: quote(bad) });
      const ms = fakeProvider("morningstar", { quote: quote(42) });
      const result = await createRegistry({ yahoo, morningstar: ms }).getQuoteWithFallback(ref());
      expect(result.quote?.price).toBe(42);
    }
  });

  it("si nadie responde: quote null, source null y la lista de intentos", async () => {
    const yahoo = fakeProvider("yahoo", { quote: null });
    const ms = fakeProvider("morningstar", { quote: new Error("caído") });
    const result = await createRegistry({ yahoo, morningstar: ms }).getQuoteWithFallback(ref());
    expect(result).toEqual({ quote: null, source: null, attempted: ["yahoo", "morningstar"] });
  });

  it("si ningún proveedor admite el instrumento: sin intentos", async () => {
    const yahoo = fakeProvider("yahoo", { supports: () => false });
    const result = await createRegistry({ yahoo }).getQuoteWithFallback(ref({ typeId: "STOCK" }));
    expect(result).toEqual({ quote: null, source: null, attempted: [] });
    expect(yahoo.calls).toHaveLength(0);
  });

  it("añadir un proveedor = una entrada en ROUTING (plan B EODHD con un falso)", async () => {
    const yahoo = fakeProvider("yahoo", { quote: null });
    const ms = fakeProvider("morningstar", { quote: null });
    const eodhd = fakeProvider("eodhd", { quote: quote(77) });
    const routing = { ...ROUTING, FUND: ["yahoo", "morningstar", "eodhd"] };
    const result = await createRegistry({ yahoo, morningstar: ms, eodhd }, routing).getQuoteWithFallback(ref());
    expect(result.source).toBe("eodhd");
    expect(result.attempted).toEqual(["yahoo", "morningstar", "eodhd"]);
  });
});

describe("getHistoryWithFallback", () => {
  it("usa el primer proveedor con datos", async () => {
    const yahoo = fakeProvider("yahoo", { history: points });
    const ms = fakeProvider("morningstar", { history: points });
    const result = await createRegistry({ yahoo, morningstar: ms }).getHistoryWithFallback(ref(), "1Y");
    expect(result.source).toBe("yahoo");
    expect(result.data).toHaveLength(2);
    expect(ms.calls).toHaveLength(0);
  });

  it("un array vacío cuenta como fallo: cae al siguiente", async () => {
    const yahoo = fakeProvider("yahoo", { history: [] });
    const ms = fakeProvider("morningstar", { history: points });
    const result = await createRegistry({ yahoo, morningstar: ms }).getHistoryWithFallback(ref(), "1Y");
    expect(result.source).toBe("morningstar");
    expect(result.attempted).toEqual(["yahoo", "morningstar"]);
  });

  it("fondo sin ticker con Morningstar caído: ni quote ni histórico, y nada lanza", async () => {
    const yahoo = fakeProvider("yahoo", { supports: (r) => Boolean(r.ticker) });
    const ms = fakeProvider("morningstar", { quote: new Error("caído"), history: new Error("caído") });
    const registry = createRegistry({ yahoo, morningstar: ms });
    const cobas = ref({ ticker: null, isin: "ES0114673033" });
    expect((await registry.getQuoteWithFallback(cobas)).attempted).toEqual(["morningstar"]);
    expect((await registry.getHistoryWithFallback(cobas, "1Y")).data).toBeNull();
    expect(yahoo.calls).toHaveLength(0);
  });

  it("una excepción no se propaga; sin datos de nadie devuelve null", async () => {
    const yahoo = fakeProvider("yahoo", { history: new Error("timeout") });
    const ms = fakeProvider("morningstar", { history: null });
    const result = await createRegistry({ yahoo, morningstar: ms }).getHistoryWithFallback(ref(), "5Y");
    expect(result).toEqual({ data: null, source: null, attempted: ["yahoo", "morningstar"] });
  });
});
