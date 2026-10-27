/**
 * Utilidades de "staleness" (precios obsoletos) — Funciones Puras
 *
 * MODO PROFESOR — ¿Qué problema resuelve esto?
 * Si Yahoo deja de darnos precio para un instrumento (ticker deslistado,
 * bloqueo, fondo sin cotización), el dashboard sigue mostrando el último
 * precio conocido SIN avisar. El usuario cree que ve datos de hoy cuando
 * en realidad son de hace una semana. Es el equivalente a un instrumento
 * de medida descalibrado: el peligro no es el error, es no saber que existe.
 *
 * Regla de la fase A: un instrumento está "stale" si lleva más de
 * 3 días HÁBILES sin precio nuevo. Usamos días hábiles porque los
 * mercados cierran los fines de semana — un precio del viernes visto
 * el lunes NO está obsoleto.
 */

/** Umbral de la fase A: >3 días hábiles sin precio nuevo = stale */
export const STALE_BUSINESS_DAYS = 3;

/**
 * Resta N días hábiles a una fecha (sin contar sábados ni domingos).
 *
 * No contempla festivos bursátiles (cada mercado tiene los suyos);
 * para el aviso de staleness es una aproximación suficiente — como mucho
 * el aviso salta un día antes alrededor de un festivo.
 */
export function subtractBusinessDays(from: Date, businessDays: number): Date {
  const result = new Date(from);
  let remaining = businessDays;

  while (remaining > 0) {
    result.setDate(result.getDate() - 1);
    const dayOfWeek = result.getDay(); // 0 = domingo, 6 = sábado
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      remaining--;
    }
  }

  return result;
}

/**
 * ¿Está obsoleto un precio cuya última fecha conocida es lastPriceDate?
 *
 * @param lastPriceDate - Fecha del último precio (null = nunca hubo precio)
 * @param now - "Hoy" (inyectable para tests)
 * @returns true si el precio tiene más de STALE_BUSINESS_DAYS días hábiles
 */
export function isPriceStale(
  lastPriceDate: Date | null,
  now: Date = new Date()
): boolean {
  if (!lastPriceDate) return true; // Sin precio histórico = obsoleto

  const threshold = subtractBusinessDays(now, STALE_BUSINESS_DAYS);
  // Comparamos solo la parte de fecha (los precios diarios no tienen hora útil)
  return lastPriceDate.getTime() < startOfDay(threshold).getTime();
}

/** Normaliza una fecha a las 00:00:00 locales (solo parte de día). */
export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}
