/**
 * Compensación de Pérdidas de Años Anteriores
 *
 * MODO PROFESOR — ¿Qué es el arrastre de pérdidas?
 *
 * En España, si vendes acciones/fondos/ETFs con pérdida en un año,
 * esas pérdidas pueden compensar ganancias de los 4 AÑOS SIGUIENTES.
 *
 * Ejemplo real:
 *   2022: Vendiste con -3.000€ de pérdida, pero solo tuviste +1.000€ de ganancias
 *         → compensas 1.000€, quedan 2.000€ pendientes de compensar
 *   2023: Tienes +5.000€ de ganancias
 *         → compensas los 2.000€ restantes de 2022
 *         → base imponible = 5.000 - 2.000 = 3.000€ (en vez de 5.000€)
 *   2026: Si no las hubieras usado, las pérdidas de 2022 CADUCAN (>4 años)
 *
 * Es como un FIFO de pérdidas con TTL (Time To Live) de 4 años.
 * Las más antiguas se aplican primero.
 *
 * Equivalente Python:
 *   pool = deque()  # cola FIFO de (año, importe)
 *   for year in sorted_years:
 *     net = gains + dividends - losses
 *     if net < 0:
 *       pool.append((year, abs(net)))
 *     else:
 *       pool = [(y, a) for y, a in pool if y + 4 >= year]  # expire
 *       while net > 0 and pool:
 *         y, a = pool[0]
 *         used = min(a, net)
 *         pool[0] = (y, a - used)
 *         net -= used
 *         if pool[0][1] == 0: pool.popleft()
 *
 * Base legal: Art. 49 Ley 35/2006 del IRPF
 */

// ─── Tipos ─────────────────────────────────────────────────────

/** Datos fiscales de un año (antes de compensación inter-anual) */
export type AnnualFiscalRaw = {
  year: number;
  totalGains: number;         // Ganancias realizadas (positivas)
  deductibleLosses: number;   // Pérdidas deducibles (excluye bloqueadas por regla 2 meses)
  grossDividends: number;     // Dividendos brutos
};

/** Entrada en el pool de pérdidas arrastrables */
export type CarryforwardEntry = {
  originYear: number;         // Año en que se generó la pérdida
  originalAmount: number;     // Importe original no compensado
  remainingAmount: number;    // Lo que queda por compensar
  expiresYear: number;        // originYear + 4
};

/** Detalle de compensación aplicada de un año concreto */
export type CompensationDetail = {
  originYear: number;
  amount: number;
};

/** Resultado completo del cálculo de compensación */
export type CarryforwardResult = {
  originalTaxableBase: number;        // Base antes de compensar (gains + divs - losses del año)
  compensatedFromPriorYears: number;  // Total compensado de años anteriores
  compensationDetails: CompensationDetail[];  // Desglose por año de origen
  adjustedTaxableBase: number;        // Base después de compensar
  remainingCarryforward: number;      // Total pendiente para años futuros
  remainingDetails: CarryforwardEntry[];      // Desglose del pool restante
};

// ─── Función principal ─────────────────────────────────────────

/**
 * Calcula la compensación de pérdidas de años anteriores para un año objetivo.
 *
 * Procesa todos los años cronológicamente desde el más antiguo,
 * manteniendo un pool FIFO de pérdidas no compensadas.
 *
 * @param annualData - Datos fiscales de cada año (no necesitan estar ordenados)
 * @param targetYear - Año para el que queremos el resultado final
 * @returns Resultado con la base ajustada y detalles de compensación
 */
export function calculateWithLossCarryforward(
  annualData: AnnualFiscalRaw[],
  targetYear: number
): CarryforwardResult {
  // Ordenar cronológicamente
  const sorted = [...annualData].sort((a, b) => a.year - b.year);

  // Pool FIFO de pérdidas arrastrables
  const pool: CarryforwardEntry[] = [];

  // Variables para capturar resultado del año objetivo
  let result: CarryforwardResult = {
    originalTaxableBase: 0,
    compensatedFromPriorYears: 0,
    compensationDetails: [],
    adjustedTaxableBase: 0,
    remainingCarryforward: 0,
    remainingDetails: [],
  };

  for (const yearData of sorted) {
    const { year, totalGains, deductibleLosses, grossDividends } = yearData;

    // Ingreso bruto del año = ganancias + dividendos
    const grossIncome = totalGains + grossDividends;

    // Resultado neto del año (antes de compensación inter-anual)
    const netIncome = grossIncome - deductibleLosses;

    if (netIncome < 0) {
      // Más pérdidas que ganancias → añadir exceso al pool
      pool.push({
        originYear: year,
        originalAmount: Math.abs(netIncome),
        remainingAmount: Math.abs(netIncome),
        expiresYear: year + 4,
      });

      // Capturar resultado si es el año objetivo
      if (year === targetYear) {
        result = {
          originalTaxableBase: 0,
          compensatedFromPriorYears: 0,
          compensationDetails: [],
          adjustedTaxableBase: 0,
          remainingCarryforward: pool.reduce((s, e) => s + e.remainingAmount, 0),
          remainingDetails: pool
            .filter((e) => e.remainingAmount > 0)
            .map((e) => ({ ...e })),
        };
      }
    } else {
      // Hay ingreso positivo → primero eliminar pérdidas expiradas
      // Una pérdida del año X caduca al inicio del año X+5
      for (let i = pool.length - 1; i >= 0; i--) {
        if (pool[i].expiresYear < year) {
          pool.splice(i, 1);
        }
      }

      // Aplicar compensación FIFO (las más antiguas primero)
      let remaining = netIncome;
      const compensations: CompensationDetail[] = [];

      for (const entry of pool) {
        if (remaining <= 0) break;
        if (entry.remainingAmount <= 0) continue;

        const compensation = Math.min(entry.remainingAmount, remaining);
        entry.remainingAmount -= compensation;
        remaining -= compensation;

        compensations.push({
          originYear: entry.originYear,
          amount: Math.round(compensation * 100) / 100,
        });
      }

      // Eliminar entradas totalmente consumidas
      for (let i = pool.length - 1; i >= 0; i--) {
        if (pool[i].remainingAmount <= 0) {
          pool.splice(i, 1);
        }
      }

      // Capturar resultado si es el año objetivo
      if (year === targetYear) {
        const totalCompensated = compensations.reduce((s, c) => s + c.amount, 0);

        result = {
          originalTaxableBase: Math.round(netIncome * 100) / 100,
          compensatedFromPriorYears: Math.round(totalCompensated * 100) / 100,
          compensationDetails: compensations,
          adjustedTaxableBase: Math.max(0, Math.round(remaining * 100) / 100),
          remainingCarryforward: Math.round(
            pool.reduce((s, e) => s + e.remainingAmount, 0) * 100
          ) / 100,
          remainingDetails: pool
            .filter((e) => e.remainingAmount > 0)
            .map((e) => ({
              ...e,
              remainingAmount: Math.round(e.remainingAmount * 100) / 100,
              originalAmount: Math.round(e.originalAmount * 100) / 100,
            })),
        };
      }
    }
  }

  return result;
}
