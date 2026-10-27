/**
 * Elección del listado al auto-crear un instrumento en la importación — Fase E.7
 *
 * MODO PROFESOR — ¿Por qué no vale "el primer resultado de Yahoo"?
 * Un mismo ISIN cotiza en varias bolsas y divisas: el ETC de oro
 * FR0013416716 sale en Yahoo como GOLD.AS (Ámsterdam, USD), .SG (Stuttgart,
 * EUR) y .MX (México, MXN), en ese orden. El resolver cogía siempre el
 * primero → el instrumento nacía en USD mientras las operaciones del CSV
 * estaban en EUR, y la app sumaba euros como si fueran dólares (sonda E.0.3,
 * correcciones C1-C5). Como `Transaction` no guarda divisa propia, la regla
 * del modelo es "los importes van en la divisa del instrumento" → hay que
 * elegir el listado cuya divisa coincide con la de la fila del CSV.
 *
 * La búsqueda de Yahoo NO devuelve la divisa, así que hay que preguntarla
 * candidato a candidato (una llamada a /chart cada uno). Se hace en orden y
 * se para en el primero que coincide: en el caso normal cuesta una llamada.
 *
 * Es como buscar en una lista de espectros el que tiene la calibración
 * correcta: los recorres por orden y te quedas con el primero que encaja;
 * si ninguno encaja, usas el primero pero lo marcas para revisarlo a mano.
 */

import { normalizeCurrency } from "@/lib/fx-utils";

/** Máximo de candidatos de Yahoo a examinar (cada uno cuesta una llamada) */
export const MAX_LISTING_CANDIDATES = 6;

export type ListingChoice<T> = {
  /** Listado elegido */
  candidate: T;
  /** Divisa normalizada del listado elegido (null si Yahoo no la dio) */
  currency: string | null;
  /**
   * - "matched": su divisa coincide con la de la fila
   * - "mismatch": ningún candidato coincide → se usa el primero, a revisar
   * - "unknown": la fila no trae divisa → el primero, como antes
   */
  match: "matched" | "mismatch" | "unknown";
};

/**
 * Elige entre los resultados de búsqueda el primer listado cuya divisa
 * (normalizada: GBp → GBP) coincide con la de la fila del CSV.
 *
 * @param candidates - Resultados de búsqueda en el orden de Yahoo
 * @param rowCurrency - Divisa de la fila del CSV (puede faltar)
 * @param getCurrency - Divisa cruda de un símbolo (null si no se sabe; no debe lanzar)
 * @returns null solo si no hay candidatos
 */
export async function chooseListingByCurrency<T extends { symbol: string }>(
  candidates: T[],
  rowCurrency: string | null | undefined,
  getCurrency: (symbol: string) => Promise<string | null>
): Promise<ListingChoice<T> | null> {
  const pool = candidates.slice(0, MAX_LISTING_CANDIDATES);
  if (pool.length === 0) return null;

  const norm = (raw: string | null) => (raw && raw.trim() ? normalizeCurrency(raw.trim()).code : null);
  const wanted = norm(rowCurrency ?? null);

  // Sin divisa en la fila: comportamiento de siempre (el primero)
  if (!wanted) {
    return { candidate: pool[0], currency: norm(await getCurrency(pool[0].symbol)), match: "unknown" };
  }

  let firstCurrency: string | null = null;
  for (let i = 0; i < pool.length; i++) {
    const currency = norm(await getCurrency(pool[i].symbol));
    if (i === 0) firstCurrency = currency;
    if (currency === wanted) return { candidate: pool[i], currency, match: "matched" };
  }

  return { candidate: pool[0], currency: firstCurrency, match: "mismatch" };
}
