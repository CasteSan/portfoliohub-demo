/**
 * fetchWithRetry — fetch endurecido para proveedores de precios externos
 *
 * MODO PROFESOR — ¿Por qué no basta el fetch normal?
 * Yahoo Finance es una API no oficial: a veces tarda, a veces devuelve
 * errores transitorios (500, 429), a veces la conexión se cuelga sin
 * responder nunca. Con el fetch "a pelo":
 *   - Sin timeout: una petición colgada bloquea el cron indefinidamente.
 *   - Sin retries: un fallo puntual de red deja el precio congelado un día.
 *
 * Este helper aplica tres defensas clásicas de sistemas distribuidos:
 *
 * 1. TIMEOUT (AbortController): cada intento tiene 10s máximo. Es como
 *    ponerle un temporizador a una integración numérica que no converge.
 *
 * 2. RETRIES con BACKOFF EXPONENCIAL: si falla, esperamos 500ms, luego 1s,
 *    luego 2s... Dar tiempo al servidor a recuperarse en vez de insistir
 *    inmediatamente (que suele empeorar el problema).
 *
 * 3. JITTER (aleatoriedad en la espera): si 100 clientes reintentan todos
 *    exactamente a los 500ms, crean una nueva avalancha sincronizada
 *    ("thundering herd"). Multiplicar por un factor aleatorio 0.5–1.5
 *    desincroniza los reintentos.
 *
 * Regla de NO-reintento: los errores 4xx (salvo 429 Too Many Requests)
 * son culpa de la petición (ticker inexistente, auth inválida...) —
 * reintentar la misma petición dará el mismo error, así que se devuelve
 * la respuesta tal cual y el caller decide.
 */

export type FetchRetryOptions = {
  /** Timeout por intento en ms (default 10_000) */
  timeoutMs?: number;
  /** Número total de intentos (default 3) */
  attempts?: number;
  /** Base del backoff exponencial en ms (default 500) */
  baseDelayMs?: number;
  /** Inyectables para tests (no usar en producción) */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ¿Merece la pena reintentar este status HTTP?
 * - 5xx: error del servidor → transitorio, reintentar
 * - 429: rate limit → reintentar tras esperar
 * - 408: request timeout → reintentar
 * - resto de 4xx: error del cliente → reintentar no ayuda
 * - 2xx/3xx: no son fallos (3xx aparece con redirect: "manual")
 */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/**
 * Delay para el intento N (0-indexed): base × 2^N × jitter(0.5–1.5)
 * Con defaults: ~250-750ms, ~500-1500ms, ~1000-3000ms
 */
function backoffDelay(attempt: number, baseDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** attempt;
  const jitter = 0.5 + Math.random(); // 0.5x – 1.5x
  return Math.round(exponential * jitter);
}

/**
 * fetch con timeout, reintentos y backoff exponencial con jitter.
 *
 * Semántica de retorno (pensada para no romper el código existente):
 * - Respuesta ok → se devuelve.
 * - Respuesta no-ok NO reintentable (4xx) → se devuelve tal cual;
 *   el caller ya maneja `!response.ok`.
 * - Respuesta no-ok reintentable → se reintenta; si se agotan los
 *   intentos, se devuelve la última respuesta (el caller ve el status).
 * - Error de red/timeout en todos los intentos → se lanza el último error
 *   (los callers ya tienen try/catch que degradan a null).
 *
 * @param url - URL a pedir
 * @param init - Opciones estándar de fetch (headers, redirect, etc.)
 * @param options - Configuración de timeout/retries
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: FetchRetryOptions = {}
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    attempts = DEFAULT_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    fetchImpl = fetch,
    sleepImpl = sleep,
  } = options;

  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    // AbortController: si el servidor no responde en timeoutMs, cancelamos
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`Timeout de ${timeoutMs}ms agotado`)),
      timeoutMs
    );

    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });

      if (response.ok || !isRetryableStatus(response.status)) {
        return response;
      }

      // Status reintentable (5xx/429/408)
      if (attempt === attempts - 1) {
        return response; // último intento: devolver lo que hay
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      // Error de red o timeout (abort)
      if (attempt === attempts - 1) {
        throw error;
      }
      lastError = error;
    } finally {
      clearTimeout(timer);
    }

    await sleepImpl(backoffDelay(attempt, baseDelayMs));
  }

  // Inalcanzable (el bucle siempre devuelve o lanza en el último intento),
  // pero TypeScript no lo sabe:
  throw lastError ?? new Error("fetchWithRetry: sin intentos ejecutados");
}
