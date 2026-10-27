/**
 * Textos de la conversión de divisas — Fase E (PUROS, testeados)
 *
 * Tabla de COPY del plan (se firma en E.7): #1 cobertura, #2 línea "≈",
 * #7 dashboard con carteras en distintas divisas. Centralizados aquí para
 * que las vistas digan lo mismo con las mismas palabras.
 */

import { formatFullCurrency } from "@/lib/format-utils";

/** Fecha yyyy-mm-dd → "DD/MM" */
export function shortRateDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${day}/${month}`;
}

/**
 * Copy #1 (cobertura) y #7 (divisas mezcladas). Devuelve [] si no hay nada
 * que avisar: con cobertura completa NO se pinta caveat (sustituye al #18
 * de D, que se mostraba siempre que hubiera varias divisas).
 */
export function fxCoverageMessages(
  missing: Array<{ instrument: string; currency: string }>,
  mixed = false
): string[] {
  const messages: string[] = [];
  if (missing.length > 0) {
    const n = missing.length;
    const list = missing.map((m) => `${m.instrument}, ${m.currency}`).join("; ");
    messages.push(
      `Sin tipo de cambio para ${n} ${n === 1 ? "posición" : "posiciones"} (${list}); se ${n === 1 ? "muestra" : "muestran"} en su divisa.`
    );
  }
  if (mixed) messages.push("Carteras en distintas divisas: el total se muestra en euros.");
  return messages;
}

/** Copy #2: "≈ 1.234,56 € al cambio del 18/09" */
export function approxBaseLine(value: number, base: string, rateDate: string | null): string {
  const amount = formatFullCurrency(value, base, 2, 2);
  return rateDate ? `≈ ${amount} al cambio del ${shortRateDate(rateDate)}` : `≈ ${amount}`;
}

/**
 * Variante del copy #2 para COSTES (Resumen de cartera): el coste en base
 * sale de avgCostBase, es decir, de los tipos del día de cada compra — no
 * del cambio de hoy, así que decir "al cambio del DD/MM" mentiría.
 * Copy #2b, firmado por Raul el 09-oct-2026.
 */
export function approxCostLine(value: number, base: string): string {
  return `≈ ${formatFullCurrency(value, base, 2, 2)} al cambio de cada compra`;
}

/** Copy #5 (Fiscal y simulador, Fase E.6) — firmado por Raul el 09-oct-2026 */
export const FISCAL_FX_NOTE =
  "Los importes en divisa extranjera se convierten al tipo de cambio de referencia del BCE del día de cada operación.";

/**
 * Copy #4 (ficha del instrumento, Fase E.7): de dónde sale el precio. El VL
 * de un fondo se publica con un día o más de retraso → con Morningstar se
 * dice de qué día es; Yahoo da la cotización del día.
 */
export function priceSourceLabel(source: string | null | undefined, asOf: string | null | undefined): string | null {
  if (source === "morningstar") {
    return asOf ? `Precio de Morningstar (VL del ${shortRateDate(asOf)})` : "Precio de Morningstar";
  }
  if (source === "yahoo") return "Precio de Yahoo Finance";
  return null;
}

/** Copy #8 (junto al badge de la última actualización, Fase E.7) */
export function fxRatesLabel(lastRateDate: string): string {
  return `Tipos de cambio del ${shortRateDate(lastRateDate)}`;
}

/**
 * Copy #9 (preview de importación, Fase E.7) — firmado por Raul el 11-oct-2026. Se pinta
 * cuando el instrumento se auto-creó con un listado cuya divisa no es la de
 * la fila del CSV: los importes se guardarían en la divisa equivocada.
 */
export function listingCurrencyWarning(symbol: string, listingCurrency: string | null, csvCurrency: string): string {
  return listingCurrency
    ? `La divisa del listado (${symbol}, ${listingCurrency}) no coincide con la de tu CSV (${csvCurrency}): revísalo antes de importar.`
    : `No se pudo comprobar la divisa del listado (${symbol}); tu CSV está en ${csvCurrency}: revísalo antes de importar.`;
}
