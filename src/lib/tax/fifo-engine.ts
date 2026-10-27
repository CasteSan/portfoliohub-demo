/**
 * Motor FIFO para Cálculo de Plusvalías (Fiscalidad Española)
 *
 * FIFO = First In, First Out
 * Hacienda española exige este método para calcular ganancias/pérdidas
 * en la venta de acciones, fondos y ETFs.
 *
 * CONCEPTO CLAVE:
 * Cada compra crea un "lote" con su coste de adquisición.
 * Al vender, se consumen lotes en orden cronológico (primero los más antiguos).
 * La ganancia = precio_venta - coste_del_lote_consumido
 *
 * EJEMPLO:
 *   Ene: Compras 100 acc a 10€ → Lote 1
 *   Mar: Compras 50 acc a 12€  → Lote 2
 *   Jun: Vendes 120 acc a 15€
 *
 *   FIFO consume:
 *     - 100 acc del Lote 1 → Ganancia: (15-10) × 100 = 500€
 *     - 20 acc del Lote 2  → Ganancia: (15-12) × 20 = 60€
 *   Total ganancia: 560€
 *   Lote 2 restante: 30 acc a 12€
 */

// ============================================
// TIPOS
// ============================================

/**
 * Un lote fiscal representa participaciones adquiridas en una fecha
 * con un coste específico. Cada BUY/TRANSFER_IN crea un lote.
 */
export type TaxLot = {
  id: string;
  transactionId: string;
  acquisitionDate: Date;
  originalShares: number;
  remainingShares: number;
  costPerShare: number;
  source: "BUY" | "TRANSFER_IN";
};

/**
 * Detalle de un lote parcialmente consumido en una venta.
 */
export type ConsumedLot = {
  lotId: string;
  transactionId: string;
  acquisitionDate: Date;
  sharesConsumed: number;
  costPerShare: number;
  costBasis: number; // sharesConsumed × costPerShare
  holdingPeriodDays: number;
};

/**
 * Una ganancia o pérdida realizada por una venta.
 */
export type RealizedGain = {
  saleTransactionId: string;
  saleDate: Date;
  instrumentId: string;
  shares: number;
  salePricePerShare: number;
  saleProceeds: number; // shares × salePricePerShare - fees
  costBasis: number; // Suma de costes de lotes consumidos
  gain: number; // saleProceeds - costBasis (positivo = ganancia, negativo = pérdida)
  gainPercent: number;
  fees: number;
  consumedLots: ConsumedLot[];
  // Período de tenencia
  shortestHoldingDays: number;
  longestHoldingDays: number;
  // Regla de los 2 meses (anti-aplicación de pérdidas)
  isLossDeductible: boolean; // true si la pérdida es deducible fiscalmente
  twoMonthRuleApplied: boolean; // true si se aplicó la regla de 2 meses
  blockingPurchaseDate?: Date; // Fecha de la compra que bloquea la pérdida
  blockingPurchaseId?: string; // ID de la transacción que bloquea
};

/**
 * Resultado completo del análisis FIFO para un instrumento.
 */
export type FIFOResult = {
  instrumentId: string;
  openLots: TaxLot[]; // Lotes aún no vendidos (posición actual)
  realizedGains: RealizedGain[]; // Ventas realizadas con su ganancia/pérdida
  summary: {
    totalGains: number; // Suma de ganancias
    totalLosses: number; // Suma de pérdidas (valor absoluto)
    deductibleLosses: number; // Pérdidas deducibles (sin regla 2 meses)
    nonDeductibleLosses: number; // Pérdidas bloqueadas por regla 2 meses
    netGainLoss: number; // Ganancia neta (ganancias - pérdidas deducibles)
    totalSharesSold: number;
    totalProceeds: number;
    totalCostBasis: number;
  };
};

/**
 * Input: una transacción simplificada para el motor FIFO.
 */
export type FIFOTransaction = {
  id: string;
  type: "BUY" | "SELL" | "TRANSFER_IN" | "TRANSFER_OUT" | "DIVIDEND" | "FEE" | "SPLIT";
  date: Date;
  shares: number;
  pricePerShare: number;
  fees: number;
  // Para TRANSFER_IN: el coste fiscal arrastrado (no el valor de mercado)
  fiscalCostPerShare?: number;
};

// ============================================
// MOTOR FIFO
// ============================================

// Constante: 2 meses en milisegundos (aproximación: 61 días)
const TWO_MONTHS_MS = 61 * 24 * 60 * 60 * 1000;

/**
 * Calcula plusvalías/minusvalías usando el método FIFO.
 * Aplica la regla de los 2 meses para pérdidas no deducibles.
 *
 * @param instrumentId - ID del instrumento
 * @param transactions - Transacciones ordenadas cronológicamente
 * @returns Resultado con lotes abiertos y ganancias realizadas
 */
export function calculateFIFO(
  instrumentId: string,
  transactions: FIFOTransaction[]
): FIFOResult {
  // Ordenar transacciones por fecha (por si acaso)
  const sortedTx = [...transactions].sort(
    (a, b) => a.date.getTime() - b.date.getTime()
  );

  // Recopilar todas las compras para la regla de 2 meses
  const allPurchases = sortedTx.filter(
    (tx) => tx.type === "BUY" || tx.type === "TRANSFER_IN"
  );

  // Estado: lotes abiertos (cola FIFO)
  const openLots: TaxLot[] = [];
  // Resultado: ganancias realizadas
  const realizedGains: RealizedGain[] = [];

  let lotCounter = 0;

  for (const tx of sortedTx) {
    switch (tx.type) {
      case "BUY": {
        // Crear nuevo lote
        // El coste incluye las comisiones prorrateadas
        const effectiveCost = tx.pricePerShare + (tx.fees / tx.shares);

        const lot: TaxLot = {
          id: `lot-${++lotCounter}`,
          transactionId: tx.id,
          acquisitionDate: tx.date,
          originalShares: tx.shares,
          remainingShares: tx.shares,
          costPerShare: effectiveCost,
          source: "BUY",
        };

        openLots.push(lot);
        break;
      }

      case "TRANSFER_IN": {
        // Crear lote con coste fiscal arrastrado
        // Si no hay fiscalCostPerShare, usamos pricePerShare (que debería ser el coste arrastrado)
        const fiscalCost = tx.fiscalCostPerShare ?? tx.pricePerShare;

        const lot: TaxLot = {
          id: `lot-${++lotCounter}`,
          transactionId: tx.id,
          acquisitionDate: tx.date, // Fecha del traspaso (no la compra original)
          originalShares: tx.shares,
          remainingShares: tx.shares,
          costPerShare: fiscalCost,
          source: "TRANSFER_IN",
        };

        openLots.push(lot);
        break;
      }

      case "SELL": {
        // Consumir lotes en orden FIFO
        const result = consumeLotsForSale(
          instrumentId,
          tx,
          openLots
        );

        if (result) {
          // Aplicar regla de los 2 meses si es una pérdida
          applyTwoMonthRule(result, tx.date, allPurchases);
          realizedGains.push(result);
        }
        break;
      }

      case "TRANSFER_OUT": {
        // Los traspasos de salida NO generan ganancia fiscal
        // Simplemente reducimos los lotes (el coste se "va" al destino)
        consumeLotsForTransferOut(tx, openLots);
        break;
      }

      // DIVIDEND, FEE, SPLIT: no afectan lotes (por ahora)
      default:
        break;
    }
  }

  // Calcular resumen
  const summary = calculateSummary(realizedGains);

  return {
    instrumentId,
    openLots: openLots.filter((lot) => lot.remainingShares > 0),
    realizedGains,
    summary,
  };
}

/**
 * Aplica la regla de los 2 meses a una ganancia/pérdida realizada.
 *
 * Art. 33.5.f LIRPF: si vendes con pérdida y has comprado (o compras)
 * valores homogéneos dentro de los 2 meses anteriores o posteriores
 * a la venta, la pérdida NO es deducible.
 *
 * IMPORTANTE: Se excluyen las compras que originaron los lotes consumidos
 * en esta misma venta. La regla busca RE-COMPRAS (otras compras diferentes)
 * que indiquen un "lavado fiscal" (wash sale).
 *
 * NOTA: Solo afecta a pérdidas (gain < 0), las ganancias siempre tributan.
 */
function applyTwoMonthRule(
  result: RealizedGain,
  saleDate: Date,
  allPurchases: FIFOTransaction[]
): void {
  // Por defecto, la pérdida es deducible
  result.isLossDeductible = true;
  result.twoMonthRuleApplied = false;

  // Solo aplicar a pérdidas
  if (result.gain >= 0) {
    return;
  }

  // IDs de las compras que originaron los lotes consumidos en esta venta
  // Estas NO cuentan como "recompras" — son las propias participaciones vendidas
  const consumedPurchaseIds = new Set(
    result.consumedLots.map((lot) => lot.transactionId)
  );

  // Calcular ventana de 2 meses
  const windowStart = new Date(saleDate.getTime() - TWO_MONTHS_MS);
  const windowEnd = new Date(saleDate.getTime() + TWO_MONTHS_MS);

  // Buscar OTRAS compras dentro de la ventana (excluyendo lotes consumidos)
  for (const purchase of allPurchases) {
    // Excluir compras consumidas en esta venta (no son recompras)
    if (consumedPurchaseIds.has(purchase.id)) continue;

    // ¿Está dentro de la ventana de 2 meses?
    if (purchase.date >= windowStart && purchase.date <= windowEnd) {
      // ¡Encontrada una recompra! La pérdida NO es deducible
      result.isLossDeductible = false;
      result.twoMonthRuleApplied = true;
      result.blockingPurchaseDate = purchase.date;
      result.blockingPurchaseId = purchase.id;
      return; // Solo necesitamos encontrar una
    }
  }
}

/**
 * Consume lotes FIFO para una venta y calcula la ganancia.
 */
function consumeLotsForSale(
  instrumentId: string,
  sale: FIFOTransaction,
  lots: TaxLot[]
): RealizedGain | null {
  let sharesToSell = sale.shares;
  const consumedLots: ConsumedLot[] = [];
  let totalCostBasis = 0;

  // Recorrer lotes en orden (FIFO - los primeros son los más antiguos)
  for (const lot of lots) {
    if (sharesToSell <= 0) break;
    if (lot.remainingShares <= 0) continue;

    // ¿Cuántas participaciones consumir de este lote?
    const sharesToConsume = Math.min(lot.remainingShares, sharesToSell);

    // Calcular coste base de estas participaciones
    const lotCostBasis = sharesToConsume * lot.costPerShare;

    // Calcular días de tenencia
    const holdingDays = Math.floor(
      (sale.date.getTime() - lot.acquisitionDate.getTime()) / (1000 * 60 * 60 * 24)
    );

    // Registrar consumo
    consumedLots.push({
      lotId: lot.id,
      transactionId: lot.transactionId,
      acquisitionDate: lot.acquisitionDate,
      sharesConsumed: sharesToConsume,
      costPerShare: lot.costPerShare,
      costBasis: lotCostBasis,
      holdingPeriodDays: holdingDays,
    });

    // Actualizar estado
    lot.remainingShares -= sharesToConsume;
    sharesToSell -= sharesToConsume;
    totalCostBasis += lotCostBasis;
  }

  // Si no pudimos vender todo, hay un problema (pero lo registramos igual)
  if (sharesToSell > 0) {
    console.warn(
      `FIFO Warning: Trying to sell ${sale.shares} shares but only ${sale.shares - sharesToSell} available`
    );
  }

  // Si no consumimos nada, no hay ganancia que registrar
  if (consumedLots.length === 0) {
    return null;
  }

  // Calcular ganancia
  const sharesSold = sale.shares - sharesToSell;
  const saleProceeds = sharesSold * sale.pricePerShare - sale.fees;
  const gain = saleProceeds - totalCostBasis;
  const gainPercent = totalCostBasis > 0 ? (gain / totalCostBasis) * 100 : 0;

  // Período de tenencia (mínimo y máximo)
  const holdingDays = consumedLots.map((cl) => cl.holdingPeriodDays);

  return {
    saleTransactionId: sale.id,
    saleDate: sale.date,
    instrumentId,
    shares: sharesSold,
    salePricePerShare: sale.pricePerShare,
    saleProceeds,
    costBasis: totalCostBasis,
    gain,
    gainPercent,
    fees: sale.fees,
    consumedLots,
    shortestHoldingDays: Math.min(...holdingDays),
    longestHoldingDays: Math.max(...holdingDays),
    // Valores por defecto - se actualizan en applyTwoMonthRule
    isLossDeductible: true,
    twoMonthRuleApplied: false,
  };
}

/**
 * Consume lotes para un TRANSFER_OUT (sin generar ganancia fiscal).
 */
function consumeLotsForTransferOut(
  transfer: FIFOTransaction,
  lots: TaxLot[]
): void {
  let sharesToTransfer = transfer.shares;

  for (const lot of lots) {
    if (sharesToTransfer <= 0) break;
    if (lot.remainingShares <= 0) continue;

    const sharesToConsume = Math.min(lot.remainingShares, sharesToTransfer);
    lot.remainingShares -= sharesToConsume;
    sharesToTransfer -= sharesToConsume;
  }
}

/**
 * Calcula el resumen de ganancias/pérdidas.
 * Distingue entre pérdidas deducibles y bloqueadas por regla de 2 meses.
 */
function calculateSummary(gains: RealizedGain[]): FIFOResult["summary"] {
  let totalGains = 0;
  let totalLosses = 0;
  let deductibleLosses = 0;
  let nonDeductibleLosses = 0;
  let totalSharesSold = 0;
  let totalProceeds = 0;
  let totalCostBasis = 0;

  for (const g of gains) {
    if (g.gain >= 0) {
      totalGains += g.gain;
    } else {
      const lossAmount = Math.abs(g.gain);
      totalLosses += lossAmount;

      if (g.isLossDeductible) {
        deductibleLosses += lossAmount;
      } else {
        nonDeductibleLosses += lossAmount;
      }
    }
    totalSharesSold += g.shares;
    totalProceeds += g.saleProceeds;
    totalCostBasis += g.costBasis;
  }

  return {
    totalGains,
    totalLosses,
    deductibleLosses,
    nonDeductibleLosses,
    // Ganancia neta solo considera pérdidas deducibles
    netGainLoss: totalGains - deductibleLosses,
    totalSharesSold,
    totalProceeds,
    totalCostBasis,
  };
}

// ============================================
// UTILIDADES
// ============================================

/**
 * Agrupa transacciones por instrumento para procesamiento FIFO.
 */
export function groupTransactionsByInstrument(
  transactions: Array<{
    id: string;
    instrumentId: string;
    type: string;
    shares: number;
    pricePerShare: number;
    fees: number;
    tradeDate: Date;
    taxMetadata?: { fiscalCostDragged?: number } | null;
  }>
): Map<string, FIFOTransaction[]> {
  const groups = new Map<string, FIFOTransaction[]>();

  for (const tx of transactions) {
    const fifoTx: FIFOTransaction = {
      id: tx.id,
      type: tx.type as FIFOTransaction["type"],
      date: tx.tradeDate,
      shares: Number(tx.shares),
      pricePerShare: Number(tx.pricePerShare),
      fees: Number(tx.fees),
      fiscalCostPerShare:
        tx.type === "TRANSFER_IN" && tx.taxMetadata?.fiscalCostDragged
          ? tx.taxMetadata.fiscalCostDragged
          : undefined,
    };

    const existing = groups.get(tx.instrumentId);
    if (existing) {
      existing.push(fifoTx);
    } else {
      groups.set(tx.instrumentId, [fifoTx]);
    }
  }

  return groups;
}

/**
 * Calcula FIFO para todas las posiciones de un portfolio.
 */
export function calculatePortfolioFIFO(
  transactions: Array<{
    id: string;
    instrumentId: string;
    type: string;
    shares: number;
    pricePerShare: number;
    fees: number;
    tradeDate: Date;
    taxMetadata?: { fiscalCostDragged?: number } | null;
  }>
): Map<string, FIFOResult> {
  const groups = groupTransactionsByInstrument(transactions);
  const results = new Map<string, FIFOResult>();

  for (const [instrumentId, txs] of groups) {
    results.set(instrumentId, calculateFIFO(instrumentId, txs));
  }

  return results;
}
