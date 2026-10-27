/**
 * Registro de proveedores de precios — Fase E.1
 *
 * Una tabla de routing por clase de activo + prioridad, y dos operaciones que
 * recorren esa prioridad sin lanzar nunca: quote y histórico. Los consumidores
 * (cron, actualización manual, gráficos, motor de evolución) hablan con el
 * registro, no con Yahoo ni con Morningstar.
 *
 * MODO PROFESOR — ¿Por qué un registro y no un `if (yahoo falla) morningstar`?
 * Antes de E el "routing" vivía copiado en tres sitios (histórico del motor,
 * histórico del instrumento y cron), cada uno con su propia idea de cuándo
 * caer a Morningstar — y el cron no caía nunca. Con el registro la regla está
 * en UNA tabla: añadir EODHD (plan B, decisión 7) es un archivo que implemente
 * `PriceProvider` y una palabra en `ROUTING`. Es la misma idea que un
 * pipeline de reducción con pasos intercambiables: el orden de calibradores
 * es configuración, no código repartido.
 *
 * `createRegistry` recibe los proveedores (inyección): los tests le pasan
 * proveedores falsos y verifican prioridad, fallback y `supports` sin red.
 */

import type {
  HistoricalDataPoint,
  HistoricalPeriod,
  InstrumentRef,
  PriceProvider,
  PriceQuote,
} from "./types";

/**
 * Prioridad de proveedores por tipo de instrumento.
 *
 * Yahoo primero en todas las rutas (sus tickers `0P…F` son diarios y llevan
 * años funcionando); Morningstar como fallback de lo que tiene VL (sonda
 * E.0.4: 100% del patrimonio en fondos). Un fondo SIN ticker cae a
 * Morningstar sin regla especial: `yahoo.supports()` devuelve false.
 */
export const ROUTING: Record<string, string[]> = {
  STOCK: ["yahoo"],
  INDEX: ["yahoo"],
  ETF: ["yahoo", "morningstar"],
  FUND: ["yahoo", "morningstar"],
  BOND: ["yahoo", "morningstar"],
};

/** Ruta de los tipos sin entrada (REIT, CRYPTO, COMMODITY, CASH…) */
export const DEFAULT_ROUTE = ["yahoo"];

export type QuoteResult = {
  quote: PriceQuote | null;
  /** Proveedor que respondió (null si ninguno) */
  source: string | null;
  /** Proveedores consultados en orden (para el CronLog) */
  attempted: string[];
};

export type HistoryResult = {
  data: HistoricalDataPoint[] | null;
  source: string | null;
  attempted: string[];
};

export function createRegistry(
  providers: Record<string, PriceProvider>,
  routing: Record<string, string[]> = ROUTING
) {
  /** Proveedores que pueden servir a esta ref, en orden de prioridad */
  function providersFor(ref: InstrumentRef): PriceProvider[] {
    const route = routing[ref.typeId] ?? DEFAULT_ROUTE;
    return route
      .map((name) => providers[name])
      .filter((p): p is PriceProvider => p !== undefined && p.supports(ref));
  }

  async function getQuoteWithFallback(ref: InstrumentRef): Promise<QuoteResult> {
    const attempted: string[] = [];
    for (const provider of providersFor(ref)) {
      attempted.push(provider.name);
      try {
        const quote = await provider.getQuote(ref);
        if (quote && Number.isFinite(quote.price) && quote.price > 0) {
          return { quote: { ...quote, source: provider.name }, source: provider.name, attempted };
        }
      } catch (error) {
        console.warn(`Registro: ${provider.name} falló la quote de ${ref.ticker ?? ref.isin}:`, error);
      }
    }
    return { quote: null, source: null, attempted };
  }

  async function getHistoryWithFallback(
    ref: InstrumentRef,
    period: HistoricalPeriod
  ): Promise<HistoryResult> {
    const attempted: string[] = [];
    for (const provider of providersFor(ref)) {
      attempted.push(provider.name);
      try {
        const data = await provider.getHistory(ref, period);
        if (data && data.length > 0) return { data, source: provider.name, attempted };
      } catch (error) {
        console.warn(`Registro: ${provider.name} falló el histórico de ${ref.ticker ?? ref.isin}:`, error);
      }
    }
    return { data: null, source: null, attempted };
  }

  return { providersFor, getQuoteWithFallback, getHistoryWithFallback };
}

export type PriceRegistry = ReturnType<typeof createRegistry>;
