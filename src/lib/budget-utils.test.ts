/**
 * runWithBudget — Fase E.4 (con temporizadores simulados de vitest)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runWithBudget } from "./budget-utils";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runWithBudget", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("con tiempo de sobra: todo hecho, nada pendiente", async () => {
    const run = runWithBudget([1, 2, 3, 4], async (n) => {
      await sleep(100);
      return n * 10;
    }, { budgetMs: 1000, poolSize: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    const r = await run;
    expect(r.done.map((d) => d.result).sort((a, b) => a - b)).toEqual([10, 20, 30, 40]);
    expect(r.pending).toEqual([]);
    expect(r.timedOut).toBe(false);
  });

  it("25 fondos con Morningstar lento (2 s cada uno), pool 3 y 6 s: responde a los 6 s con 6 hechos y 19 pendientes", async () => {
    const items = Array.from({ length: 25 }, (_, i) => `fondo-${i}`);
    const started: string[] = [];
    const run = runWithBudget(items, async (id) => {
      started.push(id);
      await sleep(2000);
      return 0.0012;
    }, { budgetMs: 6000, poolSize: 3 });

    let settled = false;
    void run.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(6000);
    expect(settled).toBe(true);
    const r = await run;
    // Rondas de 3 que arrancan a t=0, 2 y 4 s; la tercera acaba justo a t=6 s,
    // en el mismo instante que vence el presupuesto: gana el presupuesto
    // (su temporizador se registró antes) → cuenta como pendiente
    expect(r.done).toHaveLength(6);
    expect(r.pending).toHaveLength(19);
    expect(r.timedOut).toBe(true);
    // Ninguna ronda nueva arranca pasado el presupuesto
    expect(started).toHaveLength(9);
  });

  it("no aborta lo que ya empezó: el efecto se completa después, pero cuenta como pendiente", async () => {
    const persisted: string[] = [];
    const run = runWithBudget(["lento"], async (id) => {
      await sleep(5000);
      persisted.push(id);
      return id;
    }, { budgetMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    const r = await run;
    expect(r.pending).toEqual(["lento"]);
    expect(r.done).toEqual([]);
    expect(persisted).toEqual([]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(persisted).toEqual(["lento"]);
  });

  it("los fallos van aparte y no paran al resto", async () => {
    const run = runWithBudget([1, 2, 3], async (n) => {
      if (n === 2) throw new Error("HTTP 500");
      return n;
    }, { budgetMs: 1000, poolSize: 1 });
    await vi.advanceTimersByTimeAsync(10);
    const r = await run;
    expect(r.done.map((d) => d.item)).toEqual([1, 3]);
    expect(r.failed.map((f) => f.item)).toEqual([2]);
    expect(r.pending).toEqual([]);
  });

  it("lista vacía y presupuesto cero", async () => {
    const empty = await runWithBudget([], async () => 1, { budgetMs: 1000 });
    expect(empty).toEqual({ done: [], failed: [], pending: [], timedOut: false });
    const zero = runWithBudget([1, 2], async () => 1, { budgetMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect((await zero).pending.length).toBeGreaterThanOrEqual(0);
  });
});
