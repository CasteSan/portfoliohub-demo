/**
 * Tests de staleness-utils (Fase A.3.4)
 *
 * Calendario de referencia (junio 2026):
 *   L  M  X  J  V  S  D
 *   1  2  3  4  5  6  7
 *   8  9 10 11 12 13 14
 * El miércoles 10/06/2026 es el "hoy" de varios tests.
 */
import { describe, it, expect } from "vitest";
import {
  subtractBusinessDays,
  isPriceStale,
  startOfDay,
  STALE_BUSINESS_DAYS,
} from "@/lib/staleness-utils";

describe("subtractBusinessDays", () => {
  it("resta días hábiles dentro de la misma semana", () => {
    // Jueves 11 − 2 hábiles → martes 9
    const result = subtractBusinessDays(new Date(2026, 5, 11), 2);
    expect(result.getDate()).toBe(9);
  });

  it("salta el fin de semana al cruzar al viernes anterior", () => {
    // Miércoles 10 − 3 hábiles: martes 9 (1), lunes 8 (2), viernes 5 (3)
    const result = subtractBusinessDays(new Date(2026, 5, 10), 3);
    expect(result.getDate()).toBe(5);
    expect(result.getDay()).toBe(5); // viernes
  });

  it("desde un lunes, restar 1 día hábil llega al viernes", () => {
    // Lunes 8 − 1 hábil → viernes 5 (sábado y domingo no cuentan)
    const result = subtractBusinessDays(new Date(2026, 5, 8), 1);
    expect(result.getDate()).toBe(5);
  });

  it("0 días hábiles devuelve la misma fecha", () => {
    const from = new Date(2026, 5, 10, 15, 30);
    const result = subtractBusinessDays(from, 0);
    expect(result.getTime()).toBe(from.getTime());
  });

  it("no muta la fecha original", () => {
    const from = new Date(2026, 5, 10);
    subtractBusinessDays(from, 5);
    expect(from.getDate()).toBe(10);
  });
});

describe("isPriceStale", () => {
  // "Hoy" para los tests: miércoles 10/06/2026 a mediodía
  const now = new Date(2026, 5, 10, 12, 0);
  // Umbral con STALE_BUSINESS_DAYS=3: viernes 5 a las 00:00

  it("sin precio histórico (null) siempre es stale", () => {
    expect(isPriceStale(null, now)).toBe(true);
  });

  it("precio de ayer NO es stale", () => {
    expect(isPriceStale(new Date(2026, 5, 9), now)).toBe(false);
  });

  it("precio justo en el umbral (viernes 5) NO es stale", () => {
    // El umbral es estricto (<): exactamente 3 días hábiles aún es aceptable
    expect(isPriceStale(new Date(2026, 5, 5), now)).toBe(false);
  });

  it("precio anterior al umbral (jueves 4) SÍ es stale", () => {
    expect(isPriceStale(new Date(2026, 5, 4), now)).toBe(true);
  });

  it("el fin de semana no penaliza: precio del viernes visto el lunes es fresco", () => {
    const monday = new Date(2026, 5, 8, 9, 0);
    const friday = new Date(2026, 5, 5);
    expect(isPriceStale(friday, monday)).toBe(false);
  });
});

describe("startOfDay", () => {
  it("normaliza a las 00:00:00.000 conservando la fecha", () => {
    const d = startOfDay(new Date(2026, 5, 10, 18, 45, 30, 123));
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(10);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });
});

describe("constantes", () => {
  it("el umbral de la fase A es 3 días hábiles", () => {
    expect(STALE_BUSINESS_DAYS).toBe(3);
  });
});
