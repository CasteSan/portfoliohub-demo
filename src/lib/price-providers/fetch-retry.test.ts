/**
 * Tests de fetchWithRetry (Fase A.3.1)
 *
 * MODO PROFESOR — ¿Cómo se testea un fetch sin red?
 * Inyectamos un fetch falso (fetchImpl) que devuelve lo que queramos:
 * éxito, errores 500, errores de red... y un sleep falso que no espera.
 * Así el test es determinista y corre en milisegundos. Es la misma idea
 * que monkeypatchear requests en pytest.
 */
import { describe, it, expect, vi } from "vitest";
import { fetchWithRetry, isRetryableStatus } from "@/lib/price-providers/fetch-retry";

/** Crea un Response mínimo con el status dado */
function makeResponse(status: number): Response {
  return new Response(null, { status });
}

/** sleep instantáneo para no esperar backoffs reales en tests */
const noSleep = () => Promise.resolve();

describe("isRetryableStatus", () => {
  it("reintenta 5xx, 429 y 408", () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(408)).toBe(true);
  });

  it("NO reintenta 4xx normales ni 2xx/3xx", () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(302)).toBe(false);
  });
});

describe("fetchWithRetry", () => {
  it("devuelve la respuesta ok al primer intento sin reintentar", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(200));
    const sleepImpl = vi.fn(noSleep);

    const response = await fetchWithRetry("https://x.test/", {}, { fetchImpl, sleepImpl });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("reintenta ante 500 y devuelve el éxito posterior", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(500))
      .mockResolvedValueOnce(makeResponse(500))
      .mockResolvedValueOnce(makeResponse(200));
    const sleepImpl = vi.fn(noSleep);

    const response = await fetchWithRetry("https://x.test/", {}, { fetchImpl, sleepImpl });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledTimes(2); // espera entre intentos 1→2 y 2→3
  });

  it("NO reintenta un 404 (4xx = culpa de la petición)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(404));

    const response = await fetchWithRetry("https://x.test/", {}, { fetchImpl, sleepImpl: noSleep });

    expect(response.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("SÍ reintenta un 429 (rate limit es transitorio)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(429))
      .mockResolvedValueOnce(makeResponse(200));

    const response = await fetchWithRetry("https://x.test/", {}, { fetchImpl, sleepImpl: noSleep });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("agota los intentos con 500 persistente y devuelve la última respuesta", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(503));

    const response = await fetchWithRetry(
      "https://x.test/",
      {},
      { fetchImpl, sleepImpl: noSleep, attempts: 3 }
    );

    // No lanza: devuelve la respuesta no-ok para que el caller vea el status
    expect(response.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("lanza el último error si todos los intentos fallan por red", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    await expect(
      fetchWithRetry("https://x.test/", {}, { fetchImpl, sleepImpl: noSleep, attempts: 3 })
    ).rejects.toThrow("ECONNRESET");

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("se recupera de un error de red si un intento posterior funciona", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce(makeResponse(200));

    const response = await fetchWithRetry("https://x.test/", {}, { fetchImpl, sleepImpl: noSleep });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("aborta por timeout una petición que nunca responde", async () => {
    // fetch falso que solo termina cuando el AbortController lo cancela
    const hangingFetch = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason ?? new Error("aborted"))
        );
      });

    await expect(
      fetchWithRetry(
        "https://x.test/",
        {},
        { fetchImpl: hangingFetch as typeof fetch, sleepImpl: noSleep, timeoutMs: 20, attempts: 2 }
      )
    ).rejects.toThrow(/Timeout de 20ms/);
  });

  it("pasa los headers del init al fetch real", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(200));

    await fetchWithRetry(
      "https://x.test/",
      { headers: { "User-Agent": "test-agent" } },
      { fetchImpl, sleepImpl: noSleep }
    );

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers).toEqual({ "User-Agent": "test-agent" });
    expect(init.signal).toBeDefined(); // el AbortController viaja en el init
  });
});
