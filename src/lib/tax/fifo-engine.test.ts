/**
 * Tests del Motor FIFO (Fase A.1)
 *
 * MODO PROFESOR — filosofía de estos tests:
 * Cada valor esperado está derivado A MANO desde primeros principios
 * (aritmética FIFO + art. 33.5.f LIRPF), NUNCA copiando el output de la
 * implementación. Así el test actúa como "doble contabilidad": si el motor
 * y la derivación manual coinciden, la probabilidad de que ambos estén mal
 * de la misma forma es mínima. Es el equivalente a verificar una reducción
 * de espectros con una estrella estándar de flujo conocido.
 *
 * Convención de fechas: usamos strings ISO sin hora ("2024-06-03"), que
 * JavaScript interpreta como medianoche UTC. Así la aritmética de
 * milisegundos (ventana de ±61 días) es exacta, sin sorpresas de DST.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  calculateFIFO,
  groupTransactionsByInstrument,
  calculatePortfolioFIFO,
  type FIFOTransaction,
} from "@/lib/tax/fifo-engine";

// ============================================
// HELPERS — fábricas de transacciones
// ============================================

const d = (iso: string): Date => new Date(iso);

const buy = (
  id: string,
  date: string,
  shares: number,
  pricePerShare: number,
  fees = 0
): FIFOTransaction => ({ id, type: "BUY", date: d(date), shares, pricePerShare, fees });

const sell = (
  id: string,
  date: string,
  shares: number,
  pricePerShare: number,
  fees = 0
): FIFOTransaction => ({ id, type: "SELL", date: d(date), shares, pricePerShare, fees });

const transferIn = (
  id: string,
  date: string,
  shares: number,
  pricePerShare: number,
  fiscalCostPerShare?: number
): FIFOTransaction => ({
  id,
  type: "TRANSFER_IN",
  date: d(date),
  shares,
  pricePerShare,
  fees: 0,
  fiscalCostPerShare,
});

const transferOut = (id: string, date: string, shares: number): FIFOTransaction => ({
  id,
  type: "TRANSFER_OUT",
  date: d(date),
  shares,
  pricePerShare: 0,
  fees: 0,
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================
// COMPRA Y VENTA BÁSICAS
// ============================================

describe("calculateFIFO — compra y venta básicas", () => {
  it("compra simple → venta total: ganancia ajustada por comisiones", () => {
    // Derivación:
    //   Coste efectivo compra = 10 + 5/100 = 10.05 €/participación (comisión prorrateada)
    //   costBasis  = 100 × 10.05 = 1005 €
    //   proceeds   = 100 × 15 − 3 = 1497 € (comisión de venta restada)
    //   gain       = 1497 − 1005 = 492 €
    //   gainPercent= 492 / 1005 × 100 = 48.9552...%
    //   Tenencia: 2024-01-10 → 2024-06-10 (año bisiesto)
    //     = 21 (resto ene) + 29 (feb) + 31 (mar) + 30 (abr) + 31 (may) + 10 (jun) = 152 días
    const result = calculateFIFO("inst-1", [
      buy("b1", "2024-01-10", 100, 10, 5),
      sell("s1", "2024-06-10", 100, 15, 3),
    ]);

    expect(result.instrumentId).toBe("inst-1");
    expect(result.realizedGains).toHaveLength(1);

    const g = result.realizedGains[0];
    expect(g.saleTransactionId).toBe("s1");
    expect(g.shares).toBe(100);
    expect(g.salePricePerShare).toBe(15);
    expect(g.fees).toBe(3);
    expect(g.saleProceeds).toBe(1497);
    expect(g.costBasis).toBeCloseTo(1005, 6);
    expect(g.gain).toBeCloseTo(492, 6);
    expect(g.gainPercent).toBeCloseTo(48.9552, 3);

    // Lote consumido íntegro
    expect(g.consumedLots).toHaveLength(1);
    expect(g.consumedLots[0].transactionId).toBe("b1");
    expect(g.consumedLots[0].sharesConsumed).toBe(100);
    expect(g.consumedLots[0].costPerShare).toBeCloseTo(10.05, 9);
    expect(g.consumedLots[0].holdingPeriodDays).toBe(152);
    expect(g.shortestHoldingDays).toBe(152);
    expect(g.longestHoldingDays).toBe(152);

    // Ganancia: la regla de 2 meses no aplica nunca a ganancias
    expect(g.isLossDeductible).toBe(true);
    expect(g.twoMonthRuleApplied).toBe(false);

    // Venta total → no quedan lotes abiertos
    expect(result.openLots).toHaveLength(0);

    // Resumen
    expect(result.summary.totalGains).toBeCloseTo(492, 6);
    expect(result.summary.totalLosses).toBe(0);
    expect(result.summary.deductibleLosses).toBe(0);
    expect(result.summary.nonDeductibleLosses).toBe(0);
    expect(result.summary.netGainLoss).toBeCloseTo(492, 6);
    expect(result.summary.totalSharesSold).toBe(100);
    expect(result.summary.totalProceeds).toBe(1497);
    expect(result.summary.totalCostBasis).toBeCloseTo(1005, 6);
  });

  it("venta parcial multi-lote: FIFO consume primero el lote más antiguo", () => {
    // Es el ejemplo del docstring del motor, derivado a mano:
    //   Lote 1: 100 acc a 10€ (2024-01-15) · Lote 2: 50 acc a 12€ (2024-03-15)
    //   Venta: 120 acc a 15€ (2024-06-17)
    //   FIFO: 100 del Lote 1 (coste 1000) + 20 del Lote 2 (coste 240)
    //   costBasis = 1240 · proceeds = 120 × 15 = 1800 · gain = 560
    //   gainPercent = 560/1240 × 100 = 45.1612...%
    //   Tenencias: 2024-01-15→2024-06-17 = 154 días · 2024-03-15→2024-06-17 = 94 días
    const result = calculateFIFO("inst-1", [
      buy("b1", "2024-01-15", 100, 10),
      buy("b2", "2024-03-15", 50, 12),
      sell("s1", "2024-06-17", 120, 15),
    ]);

    const g = result.realizedGains[0];
    expect(g.shares).toBe(120);
    expect(g.saleProceeds).toBe(1800);
    expect(g.costBasis).toBe(1240);
    expect(g.gain).toBe(560);
    expect(g.gainPercent).toBeCloseTo(45.16129, 4);

    // Lotes consumidos en orden FIFO: primero el más antiguo
    expect(g.consumedLots).toHaveLength(2);
    expect(g.consumedLots[0].transactionId).toBe("b1");
    expect(g.consumedLots[0].sharesConsumed).toBe(100);
    expect(g.consumedLots[0].costBasis).toBe(1000);
    expect(g.consumedLots[1].transactionId).toBe("b2");
    expect(g.consumedLots[1].sharesConsumed).toBe(20);
    expect(g.consumedLots[1].costBasis).toBe(240);

    // Tenencia mínima y máxima (floor de días)
    expect(g.shortestHoldingDays).toBe(94);
    expect(g.longestHoldingDays).toBe(154);

    // Queda medio Lote 2: 30 acc a 12€
    expect(result.openLots).toHaveLength(1);
    expect(result.openLots[0].transactionId).toBe("b2");
    expect(result.openLots[0].originalShares).toBe(50);
    expect(result.openLots[0].remainingShares).toBe(30);
    expect(result.openLots[0].costPerShare).toBe(12);
  });

  it("comisiones: prorrateo en la compra y resta en los proceeds de la venta", () => {
    // Derivación:
    //   BUY 10 acc a 100€ con 10€ de comisión → coste efectivo = 100 + 10/10 = 101 €/acc
    //   SELL 10 acc a 110€ con 5€ de comisión → proceeds = 10 × 110 − 5 = 1095
    //   costBasis = 10 × 101 = 1010 · gain = 1095 − 1010 = 85
    const soloCompra = calculateFIFO("inst-1", [buy("b1", "2024-01-02", 10, 100, 10)]);
    expect(soloCompra.openLots[0].costPerShare).toBe(101);

    const conVenta = calculateFIFO("inst-1", [
      buy("b1", "2024-01-02", 10, 100, 10),
      sell("s1", "2024-03-01", 10, 110, 5),
    ]);
    const g = conVenta.realizedGains[0];
    expect(g.saleProceeds).toBe(1095);
    expect(g.costBasis).toBe(1010);
    expect(g.gain).toBe(85);
    expect(g.fees).toBe(5);
    // gainPercent = 85/1010 × 100 = 8.4158...%
    expect(g.gainPercent).toBeCloseTo(8.41584, 4);
  });

  it("costBasis = 0 → gainPercent definido como 0 (sin división por cero)", () => {
    // Caso degenerado: compra a precio 0 sin comisiones → coste base 0.
    // La implementación devuelve gainPercent = 0 en lugar de Infinity.
    const result = calculateFIFO("inst-1", [
      buy("b1", "2024-01-02", 10, 0),
      sell("s1", "2024-03-01", 10, 5),
    ]);
    const g = result.realizedGains[0];
    expect(g.costBasis).toBe(0);
    expect(g.gain).toBe(50); // 10 × 5 − 0
    expect(g.gainPercent).toBe(0);
  });
});

// ============================================
// REGLA DE LOS 2 MESES (art. 33.5.f LIRPF)
// ============================================

describe("calculateFIFO — regla de los 2 meses", () => {
  // Escenario base de pérdida:
  //   BUY 100 acc a 20€ (lejos de la ventana) · SELL 100 acc a 15€ el 2024-06-03
  //   gain = 1500 − 2000 = −500 (gainPercent = −500/2000 × 100 = −25%)
  // La ventana implementada es saleDate ± 61 días (en ms, inclusive):
  //   2024-06-03 − 61d = 2024-04-03 · 2024-06-03 + 61d = 2024-08-03

  it("pérdida + recompra 30 días después → pérdida NO deducible (regla aplica)", () => {
    // 2024-06-03 + 30 días = 2024-07-03 → dentro de la ventana
    const result = calculateFIFO("inst-1", [
      buy("b1", "2024-01-02", 100, 20),
      sell("s1", "2024-06-03", 100, 15),
      buy("b2", "2024-07-03", 50, 14),
    ]);

    const g = result.realizedGains[0];
    expect(g.gain).toBe(-500);
    expect(g.gainPercent).toBeCloseTo(-25, 6);
    expect(g.isLossDeductible).toBe(false);
    expect(g.twoMonthRuleApplied).toBe(true);
    expect(g.blockingPurchaseId).toBe("b2");
    expect(g.blockingPurchaseDate).toEqual(d("2024-07-03"));

    // La pérdida bloqueada NO resta en el neto
    expect(result.summary.totalLosses).toBe(500);
    expect(result.summary.nonDeductibleLosses).toBe(500);
    expect(result.summary.deductibleLosses).toBe(0);
    expect(result.summary.netGainLoss).toBe(0);
  });

  it("pérdida + recompra a 70 días → fuera de la ventana, pérdida deducible", () => {
    // 2024-06-03 + 70 días = 2024-08-12 → fuera de ±61 días
    const result = calculateFIFO("inst-1", [
      buy("b1", "2024-01-02", 100, 20),
      sell("s1", "2024-06-03", 100, 15),
      buy("b2", "2024-08-12", 50, 14),
    ]);

    const g = result.realizedGains[0];
    expect(g.gain).toBe(-500);
    expect(g.isLossDeductible).toBe(true);
    expect(g.twoMonthRuleApplied).toBe(false);
    expect(g.blockingPurchaseId).toBeUndefined();
    expect(g.blockingPurchaseDate).toBeUndefined();

    expect(result.summary.deductibleLosses).toBe(500);
    expect(result.summary.nonDeductibleLosses).toBe(0);
    expect(result.summary.netGainLoss).toBe(-500);
  });

  it("frontera: recompra exactamente a +61 días → dentro (ventana inclusive)", () => {
    // 2024-06-03 + 61 días = 2024-08-03: la comparación es <= windowEnd → bloquea
    const result = calculateFIFO("inst-1", [
      buy("b1", "2024-01-02", 100, 20),
      sell("s1", "2024-06-03", 100, 15),
      buy("b2", "2024-08-03", 50, 14),
    ]);

    expect(result.realizedGains[0].twoMonthRuleApplied).toBe(true);
    expect(result.realizedGains[0].isLossDeductible).toBe(false);
    expect(result.realizedGains[0].blockingPurchaseId).toBe("b2");
  });

  it("frontera: recompra a +62 días → fuera de la ventana", () => {
    // 2024-06-03 + 62 días = 2024-08-04 → ya no bloquea
    const result = calculateFIFO("inst-1", [
      buy("b1", "2024-01-02", 100, 20),
      sell("s1", "2024-06-03", 100, 15),
      buy("b2", "2024-08-04", 50, 14),
    ]);

    expect(result.realizedGains[0].twoMonthRuleApplied).toBe(false);
    expect(result.realizedGains[0].isLossDeductible).toBe(true);
  });

  it("frontera: compra exactamente a −61 días → dentro (el lado ANTERIOR también es inclusive)", () => {
    // 2024-06-03 − 61 días = 2024-04-03 = windowStart exacto (verificado con
    // Node: aritmética de ms sobre medianoche UTC). La comparación del motor
    // es purchase.date >= windowStart → bloquea.
    // b2 NO se consume en la venta: FIFO agota primero b1 (100 acc, las
    // mismas que se venden), así que b2 queda como recompra dentro de la ventana.
    // gain = 100 × 15 − 100 × 20 = −500
    const result = calculateFIFO("inst-1", [
      buy("b1", "2023-01-10", 100, 20),
      buy("b2", "2024-04-03", 50, 18),
      sell("s1", "2024-06-03", 100, 15),
    ]);

    const g = result.realizedGains[0];
    expect(g.gain).toBe(-500);
    expect(g.twoMonthRuleApplied).toBe(true);
    expect(g.isLossDeductible).toBe(false);
    expect(g.blockingPurchaseId).toBe("b2");
    expect(g.blockingPurchaseDate).toEqual(d("2024-04-03"));
  });

  it("frontera: compra a −62 días → fuera de la ventana por el lado anterior", () => {
    // 2024-06-03 − 62 días = 2024-04-02 < windowStart → no bloquea.
    // Mismo escenario que el test anterior, un día antes.
    const result = calculateFIFO("inst-1", [
      buy("b1", "2023-01-10", 100, 20),
      buy("b2", "2024-04-02", 50, 18),
      sell("s1", "2024-06-03", 100, 15),
    ]);

    const g = result.realizedGains[0];
    expect(g.gain).toBe(-500);
    expect(g.twoMonthRuleApplied).toBe(false);
    expect(g.isLossDeductible).toBe(true);
    expect(g.blockingPurchaseId).toBeUndefined();
  });

  it("frontera: recompra el MISMO día de la venta (distancia 0, centro de la ventana) → bloquea", () => {
    // saleDate ∈ [windowStart, windowEnd] trivialmente (distancia 0 ≤ 61 días).
    // La venta consume b1 íntegro (FIFO: el lote más antiguo cubre las 100 acc),
    // así que b2 queda sin consumir → recompra dentro de la ventana.
    // gain = 100 × 15 − 100 × 20 = −500
    const result = calculateFIFO("inst-1", [
      buy("b1", "2023-01-10", 100, 20),
      sell("s1", "2024-06-03", 100, 15),
      buy("b2", "2024-06-03", 50, 15),
    ]);

    const g = result.realizedGains[0];
    expect(g.gain).toBe(-500);
    expect(g.twoMonthRuleApplied).toBe(true);
    expect(g.isLossDeductible).toBe(false);
    expect(g.blockingPurchaseId).toBe("b2");
    expect(g.blockingPurchaseDate).toEqual(d("2024-06-03"));
  });

  it("la compra ANTERIOR a la venta también bloquea (ventana es ±, no solo posterior)", () => {
    // b2 el 2024-05-04 = 30 días ANTES de la venta (2024-06-03).
    // La venta de 100 acc consume íntegramente el lote de b1 (100 acc),
    // así que b2 queda sin consumir → cuenta como recompra dentro de la ventana.
    // gain = 100 × 15 − 100 × 20 = −500
    const result = calculateFIFO("inst-1", [
      buy("b1", "2023-01-10", 100, 20),
      buy("b2", "2024-05-04", 50, 18),
      sell("s1", "2024-06-03", 100, 15),
    ]);

    const g = result.realizedGains[0];
    expect(g.gain).toBe(-500);
    expect(g.isLossDeductible).toBe(false);
    expect(g.twoMonthRuleApplied).toBe(true);
    expect(g.blockingPurchaseId).toBe("b2");
    expect(g.blockingPurchaseDate).toEqual(d("2024-05-04"));
  });

  it("la compra consumida íntegramente en la propia venta NO cuenta como recompra", () => {
    // Compra 30 días antes de la venta, pero TODAS sus participaciones se
    // venden en esta operación → no es una recompra, son las propias acciones
    // vendidas. La pérdida (1500 − 2000 = −500) es deducible.
    const result = calculateFIFO("inst-1", [
      buy("b1", "2024-05-04", 100, 20),
      sell("s1", "2024-06-03", 100, 15),
    ]);

    const g = result.realizedGains[0];
    expect(g.gain).toBe(-500);
    expect(g.isLossDeductible).toBe(true);
    expect(g.twoMonthRuleApplied).toBe(false);
  });

  it("compra PARCIALMENTE consumida en la venta tampoco cuenta como recompra (comportamiento actual)", () => {
    // ⚠️ DISCREPANCIA: la implementación excluye la compra entera de la regla
    // si CUALQUIER parte de su lote se consumió en la venta. Aquí se venden
    // 40 de las 100 acc compradas dentro de la ventana: quedan 60 acc
    // homogéneas adquiridas en los 2 meses anteriores, y según el criterio de
    // la DGT sobre el art. 33.5.f LIRPF la pérdida debería quedar bloqueada
    // (diferida) mientras se conserven esos valores. La implementación la
    // considera deducible. Documentamos el comportamiento ACTUAL.
    // Derivación: gain = 40 × 15 − 40 × 20 = 600 − 800 = −200
    const result = calculateFIFO("inst-1", [
      buy("b1", "2024-05-04", 100, 20),
      sell("s1", "2024-06-03", 40, 15),
    ]);

    const g = result.realizedGains[0];
    expect(g.gain).toBe(-200);
    expect(g.isLossDeductible).toBe(true);
    expect(g.twoMonthRuleApplied).toBe(false);
    // El resto del lote sigue abierto
    expect(result.openLots[0].remainingShares).toBe(60);
  });

  it("las ganancias nunca se bloquean aunque haya recompra dentro de la ventana", () => {
    // Venta CON GANANCIA (50 × 20 − 50 × 10 = +500) y recompra 10 días después:
    // la regla solo afecta a pérdidas; la ganancia tributa siempre.
    const result = calculateFIFO("inst-1", [
      buy("b1", "2024-01-02", 100, 10),
      sell("s1", "2024-06-03", 50, 20),
      buy("b2", "2024-06-13", 30, 19),
    ]);

    const g = result.realizedGains[0];
    expect(g.gain).toBe(500);
    expect(g.isLossDeductible).toBe(true);
    expect(g.twoMonthRuleApplied).toBe(false);
    expect(g.blockingPurchaseId).toBeUndefined();
  });

  it("gain exactamente 0 se trata como ganancia: la regla no aplica aunque haya recompra", () => {
    // Frontera de signo: la implementación usa gain >= 0 → un resultado de
    // EXACTAMENTE 0 no es pérdida; la regla de 2 meses no se evalúa y el 0
    // se suma a totalGains (no a totalLosses).
    // Derivación: proceeds = 100 × 10 = 1000 · costBasis = 100 × 10 = 1000
    //   gain = 0 · gainPercent = 0/1000 × 100 = 0
    const result = calculateFIFO("inst-1", [
      buy("b1", "2024-01-02", 100, 10),
      sell("s1", "2024-06-03", 100, 10),
      buy("b2", "2024-06-13", 50, 9), // recompra a +10 días: irrelevante con gain = 0
    ]);

    const g = result.realizedGains[0];
    expect(g.gain).toBe(0);
    expect(g.gainPercent).toBe(0);
    expect(g.isLossDeductible).toBe(true);
    expect(g.twoMonthRuleApplied).toBe(false);
    expect(g.blockingPurchaseId).toBeUndefined();

    expect(result.summary.totalGains).toBe(0);
    expect(result.summary.totalLosses).toBe(0);
    expect(result.summary.netGainLoss).toBe(0);
  });

  it("comisiones que cambian el signo: gain bruto positivo pero pérdida neta → la regla SÍ aplica", () => {
    // La regla opera sobre el gain NETO de comisiones, no sobre el bruto.
    // Derivación (10.25 es exacto en binario — 1010.01₂ — sin error de redondeo):
    //   bruto    = 100 × 10.25 = 1025 > costBasis 1000 → +25 aparente
    //   proceeds = 1025 − 30 (fees) = 995
    //   gain     = 995 − 1000 = −5 → PÉRDIDA tras comisiones
    //   Recompra a +28 días (2024-07-01), dentro de la ventana → bloquea
    const result = calculateFIFO("inst-1", [
      buy("b1", "2024-01-02", 100, 10),
      sell("s1", "2024-06-03", 100, 10.25, 30),
      buy("b2", "2024-07-01", 50, 10),
    ]);

    const g = result.realizedGains[0];
    expect(g.saleProceeds).toBeCloseTo(995, 9);
    expect(g.gain).toBeCloseTo(-5, 9);
    expect(g.isLossDeductible).toBe(false);
    expect(g.twoMonthRuleApplied).toBe(true);
    expect(g.blockingPurchaseId).toBe("b2");

    expect(result.summary.totalLosses).toBeCloseTo(5, 9);
    expect(result.summary.nonDeductibleLosses).toBeCloseTo(5, 9);
    expect(result.summary.netGainLoss).toBe(0);
  });

  it("la pérdida bloqueada NO se libera al vender después las acciones que la bloquearon (comportamiento actual)", () => {
    // ⚠️ DISCREPANCIA: el art. 33.5.f LIRPF DIFIERE la pérdida, no la
    // elimina: cuando se transmiten los valores homogéneos recomprados que
    // bloquearon la pérdida, ésta debe aflorar (integrarse como deducible).
    // El motor evalúa la regla UNA sola vez en el momento de cada venta y
    // nunca la revisa → la pérdida queda bloqueada para siempre aunque las
    // acciones bloqueantes se vendan más tarde. Documentamos el
    // comportamiento ACTUAL.
    // Derivación:
    //   s1: 100 × 15 − 100 × 20 = −500 · bloqueada por b2 (+28 días)
    //   s2 (2024-12-01): vende TODO b2 → proceeds = 1600, costBasis = 1400, +200
    //   Fiscalmente correcto: al vender b2 la pérdida de 500 aflora
    //     → neto −300. El motor mantiene: nonDeductibleLosses = 500,
    //     netGainLoss = 200 − 0 = 200.
    const result = calculateFIFO("inst-1", [
      buy("b1", "2024-01-02", 100, 20),
      sell("s1", "2024-06-03", 100, 15),
      buy("b2", "2024-07-01", 100, 14),
      sell("s2", "2024-12-01", 100, 16),
    ]);

    const [g1, g2] = result.realizedGains;
    expect(g1.gain).toBe(-500);
    expect(g1.isLossDeductible).toBe(false); // sigue bloqueada tras vender b2
    expect(g1.twoMonthRuleApplied).toBe(true);
    expect(g1.blockingPurchaseId).toBe("b2");
    expect(g2.gain).toBe(200);

    expect(result.summary.totalGains).toBe(200);
    expect(result.summary.nonDeductibleLosses).toBe(500);
    expect(result.summary.deductibleLosses).toBe(0);
    expect(result.summary.netGainLoss).toBe(200); // la ley diría 200 − 500 = −300
    expect(result.openLots).toHaveLength(0);
  });

  it("un TRANSFER_IN dentro de la ventana también cuenta como recompra que bloquea", () => {
    // El motor incluye TRANSFER_IN en allPurchases: un traspaso entrante es
    // una adquisición de valores homogéneos. Traspaso 17 días después de la
    // venta con pérdida (−500) → bloquea.
    const result = calculateFIFO("inst-1", [
      buy("b1", "2023-01-10", 100, 20),
      sell("s1", "2024-06-03", 100, 15),
      transferIn("t1", "2024-06-20", 50, 14, 14),
    ]);

    const g = result.realizedGains[0];
    expect(g.gain).toBe(-500);
    expect(g.isLossDeductible).toBe(false);
    expect(g.twoMonthRuleApplied).toBe(true);
    expect(g.blockingPurchaseId).toBe("t1");
  });
});

// ============================================
// TRASPASOS (régimen de diferimiento de fondos)
// ============================================

describe("calculateFIFO — traspasos", () => {
  it("TRANSFER_IN crea lote con el coste fiscal arrastrado (no el valor de mercado)", () => {
    // Traspaso entrante: 100 part. con valor de mercado 50€ pero coste
    // fiscal original de 30€/part. El lote debe arrastrar 30, no 50.
    const result = calculateFIFO("inst-1", [
      transferIn("t1", "2024-03-01", 100, 50, 30),
    ]);

    expect(result.openLots).toHaveLength(1);
    const lot = result.openLots[0];
    expect(lot.source).toBe("TRANSFER_IN");
    expect(lot.costPerShare).toBe(30);
    expect(lot.originalShares).toBe(100);
    expect(lot.remainingShares).toBe(100);
    expect(result.realizedGains).toHaveLength(0);
  });

  it("TRANSFER_IN sin fiscalCostPerShare usa pricePerShare como coste", () => {
    const result = calculateFIFO("inst-1", [
      transferIn("t1", "2024-03-01", 100, 50),
    ]);
    expect(result.openLots[0].costPerShare).toBe(50);
  });

  it("TRANSFER_IN usa la fecha del traspaso como acquisitionDate (comportamiento actual)", () => {
    // ⚠️ DISCREPANCIA: fiscalmente, en un traspaso de fondos (régimen de
    // diferimiento, art. 94 LIRPF) las participaciones conservan la FECHA de
    // adquisición ORIGINAL, no la del traspaso. La implementación usa la
    // fecha del traspaso → holdingPeriodDays y la antigüedad quedan mal
    // calculados para lotes traspasados. Documentamos el comportamiento ACTUAL.
    const result = calculateFIFO("inst-1", [
      transferIn("t1", "2024-03-01", 100, 50, 30),
    ]);

    expect(result.openLots[0].acquisitionDate).toEqual(d("2024-03-01"));
  });

  it("TRANSFER_OUT consume lotes FIFO sin generar ganancia fiscal", () => {
    // Salen 60 de 100: no hay realizedGains y el lote queda con 40.
    const parcial = calculateFIFO("inst-1", [
      buy("b1", "2024-01-10", 100, 10),
      transferOut("t1", "2024-04-10", 60),
    ]);
    expect(parcial.realizedGains).toHaveLength(0);
    expect(parcial.openLots).toHaveLength(1);
    expect(parcial.openLots[0].remainingShares).toBe(40);
    expect(parcial.summary.netGainLoss).toBe(0);
    expect(parcial.summary.totalSharesSold).toBe(0);

    // Salida total: el lote desaparece de openLots (remainingShares = 0)
    const total = calculateFIFO("inst-1", [
      buy("b1", "2024-01-10", 100, 10),
      transferOut("t1", "2024-04-10", 100),
    ]);
    expect(total.realizedGains).toHaveLength(0);
    expect(total.openLots).toHaveLength(0);
  });

  it("TRANSFER_OUT multi-lote: salta lotes agotados y para al completar la salida", () => {
    // Tres lotes de 50 acc a 10€. La venta agota el lote b1 (FIFO).
    // El TRANSFER_OUT de 30 debe: saltar b1 (agotado), consumir 30 de b2
    // y NO tocar b3 (la salida ya está completa).
    // Derivación venta: gain = 50 × 12 − 50 × 10 = +100
    const result = calculateFIFO("inst-1", [
      buy("b1", "2024-01-02", 50, 10),
      buy("b2", "2024-02-02", 50, 10),
      buy("b3", "2024-03-02", 50, 10),
      sell("s1", "2024-04-02", 50, 12),
      transferOut("t1", "2024-05-02", 30),
    ]);

    expect(result.realizedGains).toHaveLength(1);
    expect(result.realizedGains[0].gain).toBe(100);

    // b1 agotado por la venta → fuera de openLots; b2 con 20; b3 intacto
    expect(result.openLots).toHaveLength(2);
    expect(result.openLots[0].transactionId).toBe("b2");
    expect(result.openLots[0].remainingShares).toBe(20);
    expect(result.openLots[1].transactionId).toBe("b3");
    expect(result.openLots[1].remainingShares).toBe(50);
  });

  it("vender tras un TRANSFER_IN usa el coste fiscal arrastrado como base", () => {
    // Derivación: costBasis = 100 × 8 = 800 · proceeds = 100 × 10 = 1000
    //   gain = +200 (la plusvalía latente arrastrada aflora al vender)
    const result = calculateFIFO("inst-1", [
      transferIn("t1", "2024-02-01", 100, 12, 8),
      sell("s1", "2024-09-02", 100, 10),
    ]);

    const g = result.realizedGains[0];
    expect(g.costBasis).toBe(800);
    expect(g.saleProceeds).toBe(1000);
    expect(g.gain).toBe(200);
    expect(result.openLots).toHaveLength(0);
  });
});

// ============================================
// TIPOS NEUTROS Y CASOS LÍMITE
// ============================================

describe("calculateFIFO — tipos neutros y casos límite", () => {
  it("DIVIDEND, FEE y SPLIT no afectan a los lotes ni generan ganancias", () => {
    const result = calculateFIFO("inst-1", [
      buy("b1", "2024-01-02", 100, 10),
      { id: "d1", type: "DIVIDEND", date: d("2024-03-01"), shares: 0, pricePerShare: 0.5, fees: 0 },
      { id: "f1", type: "FEE", date: d("2024-04-01"), shares: 0, pricePerShare: 0, fees: 12 },
      { id: "sp1", type: "SPLIT", date: d("2024-05-01"), shares: 100, pricePerShare: 0, fees: 0 },
    ]);

    expect(result.realizedGains).toHaveLength(0);
    expect(result.openLots).toHaveLength(1);
    expect(result.openLots[0].remainingShares).toBe(100);
    expect(result.openLots[0].costPerShare).toBe(10);
  });

  it("vender más participaciones de las disponibles: vende lo que hay y avisa por console.warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Hay 50 acc; se intenta vender 80 → solo se venden 50.
    // Derivación: proceeds = 50 × 12 = 600 · costBasis = 50 × 10 = 500 · gain = 100
    const result = calculateFIFO("inst-1", [
      buy("b1", "2024-01-02", 50, 10),
      sell("s1", "2024-03-01", 80, 12),
    ]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const g = result.realizedGains[0];
    expect(g.shares).toBe(50); // lo realmente vendido, no las 80 pedidas
    expect(g.saleProceeds).toBe(600);
    expect(g.costBasis).toBe(500);
    expect(g.gain).toBe(100);
    expect(result.openLots).toHaveLength(0);
    expect(result.summary.totalSharesSold).toBe(50);
  });

  it("oversell con fees ≠ 0: las comisiones se restan ENTERAS, sin prorratear a lo realmente vendido", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Decisión de implementación: si se piden 80 acc pero solo hay 50,
    //   proceeds = (acc realmente vendidas) × precio − fees COMPLETAS
    //            = 50 × 12 − 4 = 596 (las 4€ NO se prorratean a 50/80)
    //   costBasis = 50 × 10 = 500 · gain = 596 − 500 = 96
    const result = calculateFIFO("inst-1", [
      buy("b1", "2024-01-02", 50, 10),
      sell("s1", "2024-03-01", 80, 12, 4),
    ]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const g = result.realizedGains[0];
    expect(g.shares).toBe(50);
    expect(g.fees).toBe(4);
    expect(g.saleProceeds).toBe(596);
    expect(g.costBasis).toBe(500);
    expect(g.gain).toBe(96);
    expect(result.summary.totalProceeds).toBe(596);
  });

  it("venta sin ningún lote disponible: no genera registro de ganancia", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = calculateFIFO("inst-1", [sell("s1", "2024-03-01", 10, 12)]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(result.realizedGains).toHaveLength(0);
    expect(result.openLots).toHaveLength(0);
    expect(result.summary.totalProceeds).toBe(0);
    expect(result.summary.netGainLoss).toBe(0);
  });

  it("transacciones desordenadas cronológicamente: el motor ordena internamente", () => {
    // Mismo escenario que el test multi-lote (gain = 560), pero el array
    // llega con la venta primero. El resultado debe ser idéntico.
    const result = calculateFIFO("inst-1", [
      sell("s1", "2024-06-17", 120, 15),
      buy("b2", "2024-03-15", 50, 12),
      buy("b1", "2024-01-15", 100, 10),
    ]);

    expect(result.realizedGains).toHaveLength(1);
    expect(result.realizedGains[0].gain).toBe(560);
    expect(result.realizedGains[0].consumedLots[0].transactionId).toBe("b1");
    expect(result.openLots[0].remainingShares).toBe(30);
  });

  it("holdingPeriodDays trunca con floor (1.5 días → 1)", () => {
    // Compra a medianoche UTC, venta 36h después → 1.5 días → floor = 1
    const result = calculateFIFO("inst-1", [
      buy("b1", "2024-01-01T00:00:00Z", 10, 10),
      sell("s1", "2024-01-02T12:00:00Z", 10, 11),
    ]);

    const g = result.realizedGains[0];
    expect(g.consumedLots[0].holdingPeriodDays).toBe(1);
    expect(g.shortestHoldingDays).toBe(1);
    expect(g.longestHoldingDays).toBe(1);
  });
});

// ============================================
// RESUMEN (summary)
// ============================================

describe("calculateFIFO — summary con ganancias y pérdidas mixtas", () => {
  it("agrega ganancias, pérdidas deducibles y bloqueadas; las bloqueadas no restan en el neto", () => {
    // Escenario completo, derivado a mano:
    //   b1: BUY 100 a 10€ (2023-01-02)
    //   s1: SELL 50 a 20€ (2023-06-01) → gain = 1000 − 500 = +500
    //   s2: SELL 50 a 6€  (2024-01-08) → gain = 300 − 500 = −200
    //       Ventana ±61d = [2023-11-08, 2024-03-09]: b1 consumido en s2 (excluido),
    //       b2 y b3 fuera → DEDUCIBLE
    //   b2: BUY 100 a 8€ (2024-06-04)
    //   s3: SELL 100 a 5€ (2024-08-01) → gain = 500 − 800 = −300
    //       Ventana ±61d = [2024-06-01, 2024-10-01]: b2 consumido (excluido),
    //       b3 (2024-08-20, +19 días) bloquea → NO DEDUCIBLE
    //   b3: BUY 20 a 5.5€ (2024-08-20) → queda como lote abierto
    //
    //   summary esperado:
    //     totalGains = 500 · totalLosses = 200 + 300 = 500
    //     deductibleLosses = 200 · nonDeductibleLosses = 300
    //     netGainLoss = 500 − 200 = 300 (la bloqueada NO resta)
    //     totalSharesSold = 50 + 50 + 100 = 200
    //     totalProceeds = 1000 + 300 + 500 = 1800
    //     totalCostBasis = 500 + 500 + 800 = 1800
    const result = calculateFIFO("inst-1", [
      buy("b1", "2023-01-02", 100, 10),
      sell("s1", "2023-06-01", 50, 20),
      sell("s2", "2024-01-08", 50, 6),
      buy("b2", "2024-06-04", 100, 8),
      sell("s3", "2024-08-01", 100, 5),
      buy("b3", "2024-08-20", 20, 5.5),
    ]);

    expect(result.realizedGains).toHaveLength(3);

    const [g1, g2, g3] = result.realizedGains;
    expect(g1.gain).toBe(500);
    expect(g2.gain).toBe(-200);
    expect(g2.isLossDeductible).toBe(true);
    expect(g3.gain).toBe(-300);
    expect(g3.isLossDeductible).toBe(false);
    expect(g3.twoMonthRuleApplied).toBe(true);
    expect(g3.blockingPurchaseId).toBe("b3");

    expect(result.summary.totalGains).toBe(500);
    expect(result.summary.totalLosses).toBe(500);
    expect(result.summary.deductibleLosses).toBe(200);
    expect(result.summary.nonDeductibleLosses).toBe(300);
    expect(result.summary.netGainLoss).toBe(300);
    expect(result.summary.totalSharesSold).toBe(200);
    expect(result.summary.totalProceeds).toBe(1800);
    expect(result.summary.totalCostBasis).toBe(1800);

    // Solo queda abierto el lote de b3
    expect(result.openLots).toHaveLength(1);
    expect(result.openLots[0].transactionId).toBe("b3");
    expect(result.openLots[0].remainingShares).toBe(20);
    expect(result.openLots[0].costPerShare).toBe(5.5);
  });
});

// ============================================
// UTILIDADES: agrupación y portfolio completo
// ============================================

describe("groupTransactionsByInstrument", () => {
  it("agrupa por instrumento preservando orden y convirtiendo campos", () => {
    const rows = [
      { id: "t1", instrumentId: "A", type: "BUY", shares: 10, pricePerShare: 100, fees: 1, tradeDate: d("2024-01-02") },
      { id: "t2", instrumentId: "B", type: "TRANSFER_IN", shares: 5, pricePerShare: 50, fees: 0, tradeDate: d("2024-02-02"), taxMetadata: { fiscalCostDragged: 30 } },
      { id: "t3", instrumentId: "A", type: "SELL", shares: 4, pricePerShare: 120, fees: 2, tradeDate: d("2024-03-02") },
    ];

    const groups = groupTransactionsByInstrument(rows);

    expect(groups.size).toBe(2);
    expect(groups.get("A")).toHaveLength(2);
    expect(groups.get("B")).toHaveLength(1);

    const [a1, a2] = groups.get("A")!;
    expect(a1.id).toBe("t1");
    expect(a1.type).toBe("BUY");
    expect(a1.date).toEqual(d("2024-01-02"));
    expect(a1.shares).toBe(10);
    expect(a1.pricePerShare).toBe(100);
    expect(a1.fees).toBe(1);
    expect(a2.id).toBe("t3");
  });

  it("fiscalCostPerShare solo se asigna a TRANSFER_IN con taxMetadata.fiscalCostDragged", () => {
    const rows = [
      // TRANSFER_IN con coste arrastrado → se propaga
      { id: "t1", instrumentId: "A", type: "TRANSFER_IN", shares: 5, pricePerShare: 50, fees: 0, tradeDate: d("2024-02-02"), taxMetadata: { fiscalCostDragged: 30 } },
      // TRANSFER_IN sin metadata → undefined
      { id: "t2", instrumentId: "A", type: "TRANSFER_IN", shares: 5, pricePerShare: 40, fees: 0, tradeDate: d("2024-03-02"), taxMetadata: null },
      // BUY con metadata → se ignora (solo aplica a TRANSFER_IN)
      { id: "t3", instrumentId: "A", type: "BUY", shares: 5, pricePerShare: 45, fees: 0, tradeDate: d("2024-04-02"), taxMetadata: { fiscalCostDragged: 99 } },
    ];

    const txs = groupTransactionsByInstrument(rows).get("A")!;
    expect(txs[0].fiscalCostPerShare).toBe(30);
    expect(txs[1].fiscalCostPerShare).toBeUndefined();
    expect(txs[2].fiscalCostPerShare).toBeUndefined();
  });
});

describe("calculatePortfolioFIFO", () => {
  it("calcula FIFO por instrumento, con coste fiscal arrastrado en TRANSFER_IN", () => {
    // inst-A: BUY 10 a 100 → SELL 10 a 120 → gain = 1200 − 1000 = +200
    // inst-B: TRANSFER_IN 100 part. (mercado 12, fiscal 8) → SELL 100 a 10
    //   → costBasis = 800 (coste arrastrado, NO 1200 de mercado)
    //   → gain = 1000 − 800 = +200
    const rows = [
      { id: "t1", instrumentId: "inst-A", type: "BUY", shares: 10, pricePerShare: 100, fees: 0, tradeDate: d("2024-01-02") },
      { id: "t2", instrumentId: "inst-A", type: "SELL", shares: 10, pricePerShare: 120, fees: 0, tradeDate: d("2024-05-02") },
      { id: "t3", instrumentId: "inst-B", type: "TRANSFER_IN", shares: 100, pricePerShare: 12, fees: 0, tradeDate: d("2024-02-01"), taxMetadata: { fiscalCostDragged: 8 } },
      { id: "t4", instrumentId: "inst-B", type: "SELL", shares: 100, pricePerShare: 10, fees: 0, tradeDate: d("2024-09-02") },
    ];

    const results = calculatePortfolioFIFO(rows);

    expect(results.size).toBe(2);

    const a = results.get("inst-A")!;
    expect(a.instrumentId).toBe("inst-A");
    expect(a.realizedGains[0].gain).toBe(200);
    expect(a.summary.netGainLoss).toBe(200);

    const b = results.get("inst-B")!;
    expect(b.realizedGains[0].costBasis).toBe(800);
    expect(b.realizedGains[0].gain).toBe(200);
    expect(b.openLots).toHaveLength(0);
  });
});
