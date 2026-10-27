/**
 * Utilidades de formato compartidas — Fase C.1
 *
 * MODO PROFESOR — ¿Por qué un formato compacto propio y no
 * `Intl.NumberFormat` con `notation: "compact"`?
 * En es-ES el modo compact de Intl produce "37,4 mil €", que es más largo
 * que el importe que intenta abreviar. La convención del sector financiero
 * (Morningstar, brokers) es "k€"/"M€": corta, inequívoca y estable entre
 * navegadores. El tick de un eje es orientación, no dato — la precisión
 * completa vive en el tooltip.
 */

/**
 * Símbolo de una divisa en formato estrecho ("€", "$", "£"...).
 * Cacheado por divisa: `formatToParts` es caro y los ticks se formatean
 * decenas de veces por render.
 */
const symbolCache = new Map<string, string>();

function currencySymbol(currency: string): string {
  const cached = symbolCache.get(currency);
  if (cached) return cached;

  let symbol: string;
  try {
    const parts = new Intl.NumberFormat("es-ES", {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    }).formatToParts(1);
    symbol = parts.find((p) => p.type === "currency")?.value ?? currency;
  } catch {
    // Código de divisa inválido → usarlo tal cual antes que romper el eje
    symbol = currency;
  }
  symbolCache.set(currency, symbol);
  return symbol;
}

/**
 * Formatters Intl cacheados: construir un Intl.NumberFormat/DateTimeFormat
 * cuesta decenas de µs (hasta ~1ms en móviles modestos) y el crosshair los
 * pedía por llamada a 60fps (hallazgo de la review de Fase C). Mismo patrón
 * de caché que currencySymbol.
 */
const numberFormatterCache = new Map<string, Intl.NumberFormat>();

function getNumberFormatter(minDecimals: number, maxDecimals: number): Intl.NumberFormat {
  const key = `${minDecimals}:${maxDecimals}`;
  let formatter = numberFormatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat("es-ES", {
      minimumFractionDigits: minDecimals,
      maximumFractionDigits: maxDecimals,
    });
    numberFormatterCache.set(key, formatter);
  }
  return formatter;
}

function formatNumber(value: number, decimals: number, maxDecimals = decimals): string {
  return getNumberFormatter(decimals, maxDecimals).format(value);
}

const currencyFormatterCache = new Map<string, Intl.NumberFormat>();

/**
 * Importe COMPLETO como moneda ("9.206,42 €") para tooltips y stats.
 * Sustituye a los formatCurrency/formatPrice/formatEUR que vivían
 * duplicados en tres componentes de gráficos.
 */
export function formatFullCurrency(
  value: number,
  currency: string = "EUR",
  minDecimals: number = 0,
  maxDecimals: number = 2
): string {
  const key = `${currency}:${minDecimals}:${maxDecimals}`;
  let formatter = currencyFormatterCache.get(key);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat("es-ES", {
        style: "currency",
        currency,
        minimumFractionDigits: minDecimals,
        maximumFractionDigits: maxDecimals,
      });
    } catch {
      formatter = getNumberFormatter(minDecimals, maxDecimals);
    }
    currencyFormatterCache.set(key, formatter);
  }
  return formatter.format(value);
}

let chartDateFormatter: Intl.DateTimeFormat | null = null;

/**
 * Fecha de tooltip de gráficos ("10 jul 26"). timeZone UTC a propósito:
 * las fechas de series son strings yyyy-mm-dd que new Date() interpreta
 * como medianoche UTC — formatear en zona local mostraba el día anterior
 * a los usuarios al oeste de UTC, en desacuerdo con el eje del gráfico
 * (que sí es TZ-safe). Hallazgo de la review de Fase C.
 */
export function formatChartDate(dateStr: string): string {
  if (!chartDateFormatter) {
    chartDateFormatter = new Intl.DateTimeFormat("es-ES", {
      day: "numeric",
      month: "short",
      year: "2-digit",
      timeZone: "UTC",
    });
  }
  return chartDateFormatter.format(new Date(dateStr));
}

/**
 * Espacio NO separable entre cifra y unidad ("37,4 k€").
 * Recharts hace word-wrap por los espacios normales cuando el texto excede
 * el `width` del eje → un tick partido en dos líneas. Con NBSP el tick es
 * siempre una sola línea.
 */
const NBSP = " ";

/**
 * Importe compacto para ticks de eje: "37,4 k€", "136 k€", "1,23 M€", "850 €".
 *
 * Reglas (decisión validada del plan de Fase C — en TODOS los viewports):
 * - |valor| ≥ 1M → millones con 2 decimales ("1,23 M€")
 * - |valor| ≥ 1000 → miles con ~3 cifras significativas: 1 decimal hasta
 *   100k ("37,4 k€"), sin decimal desde 100k ("136 k€") — el decimal a esa
 *   escala es <0,1% del valor y solo ensancha el eje (medido en C.1)
 * - |valor| < 1000 → entero ("850 €")
 * - Negativos con signo ("-37,4 k€")
 * - Borde de redondeo: nunca debe verse "1.000 k€" — si el redondeo en
 *   escala k llega a 1000, se promociona a "1,00 M€"
 */
export function formatCompactCurrency(value: number, currency: string = "EUR"): string {
  const symbol = currencySymbol(currency);
  const abs = Math.abs(value);

  if (abs < 1000) {
    return `${formatNumber(value, 0)}${NBSP}${symbol}`;
  }

  // ¿El redondeo con los decimales de la escala k llega a 1000? → escala M
  const kDecimals = abs < 100_000 ? 1 : 0;
  const factor = 10 ** kDecimals;
  const roundedK = Math.round((abs / 1000) * factor) / factor;
  if (abs >= 1_000_000 || roundedK >= 1000) {
    return `${formatNumber(value / 1_000_000, 2)}${NBSP}M${symbol}`;
  }

  return `${formatNumber(value / 1000, 0, kDecimals)}${NBSP}k${symbol}`;
}

/**
 * Tick de eje de PRECIOS: compacto solo si ≥1000; por debajo, decimales
 * dinámicos según la amplitud del eje (`span` = max − min del dominio).
 *
 * MODO PROFESOR — ¿Por qué dinámicos? Un fondo a 142,37 € con el eje entre
 * 138 y 146 no puede mostrarse como "142 €": todos los ticks se verían casi
 * iguales. Pero un valor a 600 € con el eje entre 200 y 900 no necesita
 * céntimos. La amplitud del eje decide cuánta precisión aporta información:
 * - span ≥ 100 → sin decimales ("600 €")
 * - span ≥ 10  → 1 decimal ("142,4 €")
 * - span < 10  → 2 decimales ("142,37 €")
 */
export function formatPriceTick(value: number, currency: string, span: number): string {
  // Compacto solo cuando su resolución (0,1 k = 100 €) puede distinguir los
  // ticks entre sí: un instrumento a 1.250 € con eje de ±5 € mostraría
  // TODOS los ticks como "1,3 k€" (hallazgo de la review de Fase C) —
  // con eje estrecho, formato completo con decimales dinámicos.
  if (Math.abs(value) >= 1000 && span >= 1000) {
    return formatCompactCurrency(value, currency);
  }
  const decimals = span >= 100 ? 0 : span >= 10 ? 1 : 2;
  return `${formatNumber(value, decimals)}${NBSP}${currencySymbol(currency)}`;
}
