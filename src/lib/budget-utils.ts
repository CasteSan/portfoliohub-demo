/**
 * Ejecución con presupuesto de tiempo — Fase E.4
 *
 * MODO PROFESOR — "Poblar con presupuesto"
 * Una petición web no puede esperar a 25 consultas externas lentas (Vercel
 * Hobby corta a los 10-60 s). En vez de todo-o-nada: se trabaja en paralelo
 * (pool) mientras quede tiempo, se responde con lo que hay y se dice cuánto
 * falta. Lo que no dio tiempo lo completa el cron de noche. Es como observar
 * con una ventana de tiempo de telescopio fija: se integra lo que cabe y el
 * resto se programa para la noche siguiente.
 *
 * Reglas: no se ARRANCA ningún trabajo nuevo pasado el presupuesto; los que
 * ya empezaron NO se abortan (terminan en segundo plano y sus efectos —p.ej.
 * persistir un TER— se conservan), pero la función devuelve en cuanto vence
 * el presupuesto y los cuenta como pendientes.
 */

export type BudgetResult<T, R> = {
  /** Trabajos terminados dentro del presupuesto, con su resultado */
  done: Array<{ item: T; result: R }>;
  /** Trabajos que fallaron (lanzaron) dentro del presupuesto */
  failed: Array<{ item: T; error: unknown }>;
  /** No arrancados + arrancados sin terminar al vencer el presupuesto */
  pending: T[];
  /** true si se devolvió por presupuesto agotado (no por terminar todo) */
  timedOut: boolean;
};

export async function runWithBudget<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  options: { budgetMs: number; poolSize?: number }
): Promise<BudgetResult<T, R>> {
  const poolSize = Math.max(1, options.poolSize ?? 3);
  const deadline = Date.now() + options.budgetMs;
  const done: BudgetResult<T, R>["done"] = [];
  const failed: BudgetResult<T, R>["failed"] = [];
  const finished = new Set<number>();
  let next = 0;
  let expired = false;

  const lane = async () => {
    while (!expired && next < items.length && Date.now() < deadline) {
      const index = next++;
      try {
        const result = await worker(items[index]);
        if (!expired) done.push({ item: items[index], result });
      } catch (error) {
        if (!expired) failed.push({ item: items[index], error });
      } finally {
        if (!expired) finished.add(index);
      }
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, options.budgetMs));
  });
  const all = Promise.all(Array.from({ length: Math.min(poolSize, items.length) }, lane)).then(
    () => "done" as const
  );

  const outcome = await Promise.race([all, budget]);
  clearTimeout(timer);
  expired = true;

  return {
    done,
    failed,
    pending: items.filter((_, i) => !finished.has(i)),
    timedOut: outcome === "timeout",
  };
}
