/**
 * Riesgo en lenguaje claro — Fase D.3 (metodología de la decisión 4 del plan)
 *
 * MODO PROFESOR — ¿Por qué 1,65 × σ y no "el peor año que hemos visto"?
 * Con ~2 años de histórico solo existe ~1 año de ventanas móviles de 12
 * meses, todas solapadas (n efectivo ≈ 2): el "peor año observado" sería
 * ruido con aspecto de dato. La volatilidad diaria anualizada usa los ~500
 * retornos reales — una base estadística incomparablemente mejor. 1,65σ es
 * el percentil 5 de una normal centrada en 0: "1 año de cada 20". Las colas
 * reales son más gordas que la normal, así que la cifra se presenta SIEMPRE
 * redondeada y como orden de magnitud ("en torno a un 20%"), nunca como
 * límite, salvo el tope del 100 % (abajo). No restamos la media (μ − 1,65σ
 * sería MENOS conservador).
 *
 * La normal tampoco tiene suelo: con σ > 60,6 % el percentil 5 supera el
 * 100 %, y sin apalancamiento nadie pierde más de lo que tiene (Amper, con
 * σ ≈ 80 %, mostró "133 %"). Por eso la cifra se acota a RISK_PHRASE_MAX en
 * la única función que la produce, y la card cambia el copy al tocar el tope.
 * Ojo con la banda de redondeo: con σ entre 60,30 % y 60,61 % la cifra
 * redondeada ya es 100 sin que la estimación supere el tope; para saber si
 * lo supera de verdad está riskPhraseExceedsMax, que mira el valor crudo.
 *
 * El badge 1-7 usa los cubos del SRRI (el indicador UCITS que precedió al
 * SRI de los KID PRIIPs): mapea volatilidad anualizada a la escala que los
 * clientes ya conocen de los folletos de sus fondos.
 */

/** Umbral mínimo de días de trading para estimar riesgo anual (1 año) */
export const RISK_MIN_TRADING_DAYS = 252;

/**
 * Tope de la caída estimada, en puntos porcentuales: sin apalancamiento no
 * se puede perder más del 100 %. Exportado para que la card sepa cuándo la
 * cifra ha chocado con el tope y cambie el copy.
 */
export const RISK_PHRASE_MAX = 100;

/**
 * Caída estimada "en un año malo" (1 de cada 20): 1,65 × σ anualizada,
 * redondeada a puntos porcentuales ENTEROS (la precisión decimal sería
 * falsa precisión con 2 años de datos) y acotada a RISK_PHRASE_MAX.
 *
 * @param volatility - volatilidad anualizada en tanto por uno (0.12 = 12%)
 * @returns caída estimada en puntos porcentuales enteros (0.12 → 20; 0.80 → 100)
 */
export function riskPhraseValue(volatility: number): number {
  if (!Number.isFinite(volatility) || volatility <= 0) return 0;
  return Math.min(RISK_PHRASE_MAX, Math.round(1.65 * volatility * 100));
}

/**
 * ¿La estimación 1,65σ SIN redondear supera el tope? Decide la nota de la
 * card: derivarla de riskPhraseValue diría "supera el 100 %" también cuando
 * el cálculo solo redondea a 100 (σ = 60,5 % → 99,825 → 100).
 *
 * @param volatility - volatilidad anualizada en tanto por uno (0.12 = 12%)
 * @returns true solo si 1,65 × σ × 100 > RISK_PHRASE_MAX (0.605 → false; 0.61 → true)
 */
export function riskPhraseExceedsMax(volatility: number): boolean {
  if (!Number.isFinite(volatility) || volatility <= 0) return false;
  return 1.65 * volatility * 100 > RISK_PHRASE_MAX;
}

/**
 * Cubos de volatilidad del SRRI (CESR/10-673): fronteras SUPERIORES de cada
 * nivel, en tanto por uno. La frontera pertenece al nivel inferior
 * (σ = 2% exacto → nivel 2, igual que en la tabla oficial "hasta el 2%").
 */
const SRRI_BUCKETS: Array<{ max: number; level: number }> = [
  { max: 0.005, level: 1 },
  { max: 0.02, level: 2 },
  { max: 0.05, level: 3 },
  { max: 0.1, level: 4 },
  { max: 0.15, level: 5 },
  { max: 0.25, level: 6 },
];

/**
 * Nivel de riesgo 1-7 según los cubos de volatilidad del SRRI.
 *
 * @param volatility - volatilidad anualizada en tanto por uno (0.12 = 12%)
 * @returns nivel 1-7 (>25% → 7)
 */
export function volatilityToSRRIBucket(volatility: number): number {
  if (!Number.isFinite(volatility) || volatility < 0) return 1;
  for (const bucket of SRRI_BUCKETS) {
    if (volatility <= bucket.max) return bucket.level;
  }
  return 7;
}
