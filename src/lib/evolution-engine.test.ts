/**
 * Tests de caracterización del motor de evolución — Fase C.2
 *
 * MODO PROFESOR — ¿Qué es un test de caracterización?
 * C.2 extrae a `evolution-engine.ts` un bloque que vivía duplicado en los
 * dos endpoints de evolución. La fase NO debe cambiar la lógica de dominio:
 * estos tests fijan el comportamiento actual (derivado A MANO paso a paso,
 * abajo) y el motor extraído debe reproducirlo exactamente. Además, tras el
 * refactor se verificó contra el servidor real: las respuestas de los 12
 * endpoint×periodo son byte a byte idénticas a las capturadas antes.
 *
 * Derivación a mano del fixture principal (2 instrumentos, 5 fechas):
 *
 *   Precios crudos:  A = {d1: 10, d3: 12, d5: 11}   (avgCost 10)
 *                    B = {d2: 50, d4: 55}            (avgCost 50)
 *   Unión de fechas: d1..d5 (d1,d3,d5 de A; d2,d4 de B)
 *   Forward-fill:    A → 10, 10, 12, 12, 11
 *                    B → 50*, 50, 50, 55, 55         (* avgCost: aún sin precio)
 *
 *   Transacciones:   d1 BUY  A 100@10 · d2 BUY B 10@50
 *                    d3 SELL A  50@12 · d4 TRANSFER_OUT B 10@55
 *
 *   d1: A=100sh/1000€           → value 100×10        = 1000 · invested 1000
 *   d2: +B=10sh/500€            → value 1000 + 10×50  = 1500 · invested 1500
 *   d3: A vende 50 → 50sh, coste proporcional 50×(1000/100)=500
 *                               → value 50×12 + 500   = 1100 · invested 1000
 *   d4: B sale entera (≤0.0001) → value 50×12         =  600 · invested  500
 *   d5:                         → value 50×11         =  550 · invested  500
 *
 *   cumFlow (flujo neto acumulado a PRECIOS DE TRANSACCIÓN, micro-fase
 *   fix-twr-cashflows — distinto de invested cuando la venta lleva plusvalía):
 *   d1: +100×10 = 1000 · d2: +10×50 → 1500 · d3: −50×12 → 900 (invested
 *   retira 500 de coste; cumFlow los 600 de ingresos reales)
 *   d4: −10×55 → 350 · d5: 350
 */
import { describe, it, expect } from "vitest";
import {
  computeEvolution,
  collectSortedDates,
  forwardFillHistories,
  downsampleWeekly,
  isoWeekKey,
  type EngineInstrument,
  type EngineTransaction,
  type PriceHistories,
} from "@/lib/evolution-engine";

const d1 = "2024-01-01";
const d2 = "2024-01-02";
const d3 = "2024-01-03";
const d4 = "2024-01-04";
const d5 = "2024-01-05";

const instruments: EngineInstrument[] = [
  { instrumentId: "A", avgCost: 10 },
  { instrumentId: "B", avgCost: 50 },
];

function makePrices(): PriceHistories {
  return new Map([
    ["A", new Map([[d1, 10], [d3, 12], [d5, 11]])],
    ["B", new Map([[d2, 50], [d4, 55]])],
  ]);
}

const transactions: EngineTransaction[] = [
  { instrumentId: "A", type: "BUY", shares: 100, pricePerShare: 10, tradeDate: d1 },
  { instrumentId: "B", type: "BUY", shares: 10, pricePerShare: 50, tradeDate: d2 },
  { instrumentId: "A", type: "SELL", shares: 50, pricePerShare: 12, tradeDate: d3 },
  { instrumentId: "B", type: "TRANSFER_OUT", shares: 10, pricePerShare: 55, tradeDate: d4 },
];

describe("computeEvolution (fixture principal derivado a mano)", () => {
  it("reproduce la serie completa exactamente", () => {
    expect(computeEvolution(instruments, makePrices(), transactions)).toEqual([
      { date: d1, value: 1000, invested: 1000, cumFlow: 1000 },
      { date: d2, value: 1500, invested: 1500, cumFlow: 1500 },
      { date: d3, value: 1100, invested: 1000, cumFlow: 900 },
      { date: d4, value: 600, invested: 500, cumFlow: 350 },
      { date: d5, value: 550, invested: 500, cumFlow: 350 },
    ]);
  });

  it("recorta las fechas anteriores a la primera transacción", () => {
    // Solo la compra de B en d2 → d1 (fecha de precio de A) desaparece
    const soloB = transactions.filter((t) => t.instrumentId === "B" && t.type === "BUY");
    const result = computeEvolution(instruments, makePrices(), soloB);
    expect(result.map((p) => p.date)).toEqual([d2, d3, d4, d5]);
  });

  it("sin transacciones: todas las fechas, valor e invertido a 0", () => {
    const result = computeEvolution(instruments, makePrices(), []);
    expect(result).toHaveLength(5);
    for (const point of result) {
      expect(point.value).toBe(0);
      expect(point.invested).toBe(0);
      expect(point.cumFlow).toBe(0);
    }
  });

  it("una transacción posterior a todas las fechas nunca se aplica", () => {
    const futuras: EngineTransaction[] = [
      { instrumentId: "A", type: "BUY", shares: 1, pricePerShare: 10, tradeDate: "2024-06-01" },
    ];
    // firstTxDate posterior a todas las fechas de precios → serie vacía
    expect(computeEvolution(instruments, makePrices(), futuras)).toEqual([]);
  });

  it("venta parcial reduce el coste proporcionalmente (coste medio ponderado)", () => {
    // BUY 100@10 (coste 1000) + BUY 100@20 (coste 2000) → 200sh, 3000€
    // SELL 50 → quedan 150sh × (3000/200) = 2250€ de coste
    const txs: EngineTransaction[] = [
      { instrumentId: "A", type: "BUY", shares: 100, pricePerShare: 10, tradeDate: d1 },
      { instrumentId: "A", type: "BUY", shares: 100, pricePerShare: 20, tradeDate: d2 },
      { instrumentId: "A", type: "SELL", shares: 50, pricePerShare: 12, tradeDate: d3 },
    ];
    const result = computeEvolution([instruments[0]], makePrices(), txs);
    const puntoD3 = result.find((p) => p.date === d3)!;
    expect(puntoD3.invested).toBe(2250);
    expect(puntoD3.value).toBe(150 * 12);
    // cumFlow usa los ingresos REALES de la venta: 1000 + 2000 − 50×12 = 2400
    // (invested retiró 750 de coste medio; cumFlow los 600 que salieron)
    expect(puntoD3.cumFlow).toBe(2400);
  });

  it("las transacciones de instrumentos SIN posición actual se ignoran enteras (también en cumFlow)", () => {
    // El enfoque híbrido solo reconstruye instrumentos con posición actual:
    // "Z" (comprado y vendido del todo en el pasado) no está en `instruments`,
    // y value/invested nunca lo contaron. Sus flujos tampoco deben entrar en
    // cumFlow — si entraran, cada compra/venta suya sería un retorno fantasma
    // en el TWR (una compra de 5.000€ sin subida de value = −5.000 "perdidos").
    const txs: EngineTransaction[] = [
      { instrumentId: "A", type: "BUY", shares: 100, pricePerShare: 10, tradeDate: d1 },
      { instrumentId: "Z", type: "BUY", shares: 50, pricePerShare: 100, tradeDate: d2 },
      { instrumentId: "Z", type: "SELL", shares: 50, pricePerShare: 120, tradeDate: d4 },
    ];
    const result = computeEvolution([instruments[0]], makePrices(), txs);
    // Serie idéntica a tener solo la compra de A: Z no deja rastro
    const porFecha = new Map(result.map((p) => [p.date, p]));
    expect(porFecha.get(d2)).toEqual({ date: d2, value: 1000, invested: 1000, cumFlow: 1000 });
    expect(porFecha.get(d4)).toEqual({ date: d4, value: 1200, invested: 1000, cumFlow: 1000 });
    expect(porFecha.get(d5)).toEqual({ date: d5, value: 1100, invested: 1000, cumFlow: 1000 });
  });

  it("cumFlow acumula a precios de transacción y NO se recalcula con precios de mercado", () => {
    // Venta TOTAL con plusvalía (el caso del ticket del TWR): buy 100@10,
    // el precio dobla, sell 100@20. invested colapsa a 0 (posición cerrada);
    // cumFlow refleja el neto real: 1000 − 2000 = −1000.
    const txs: EngineTransaction[] = [
      { instrumentId: "A", type: "BUY", shares: 100, pricePerShare: 10, tradeDate: d1 },
      { instrumentId: "A", type: "SELL", shares: 100, pricePerShare: 20, tradeDate: d3 },
    ];
    const result = computeEvolution([instruments[0]], makePrices(), txs);
    const porFecha = new Map(result.map((p) => [p.date, p]));
    expect(porFecha.get(d1)).toEqual({ date: d1, value: 1000, invested: 1000, cumFlow: 1000 });
    expect(porFecha.get(d3)).toEqual({ date: d3, value: 0, invested: 0, cumFlow: -1000 });
    // Días posteriores sin transacciones: cumFlow se mantiene (es acumulado)
    expect(porFecha.get(d5)!.cumFlow).toBe(-1000);
  });

  it("redondea value e invested a céntimos", () => {
    const txs: EngineTransaction[] = [
      { instrumentId: "A", type: "BUY", shares: 3, pricePerShare: 10.111, tradeDate: d1 },
    ];
    const precios: PriceHistories = new Map([["A", new Map([[d1, 10.114]])]]);
    const [punto] = computeEvolution([instruments[0]], precios, txs);
    expect(punto.value).toBe(30.34); // 3 × 10,114 = 30,342
    expect(punto.invested).toBe(30.33); // 3 × 10,111 = 30,333
    expect(punto.cumFlow).toBe(30.33); // mismo redondeo a céntimos
  });
});

describe("collectSortedDates", () => {
  it("une y ordena las fechas de todos los históricos", () => {
    expect(collectSortedDates(makePrices(), null)).toEqual([d1, d2, d3, d4, d5]);
  });

  it("filtra las fechas anteriores a firstTxDate (inclusive se queda)", () => {
    expect(collectSortedDates(makePrices(), d3)).toEqual([d3, d4, d5]);
  });
});

describe("isoWeekKey (bordes de año ISO 8601)", () => {
  it("días normales", () => {
    expect(isoWeekKey("2024-06-05")).toBe("2024-W23"); // miércoles
  });

  it("el 30-dic-2024 (lunes) pertenece a la W01 de 2025", () => {
    expect(isoWeekKey("2024-12-30")).toBe("2025-W01");
    expect(isoWeekKey("2025-01-02")).toBe("2025-W01"); // jueves, misma semana
  });

  it("el 29-dic-2024 (domingo) cierra la W52 de 2024", () => {
    expect(isoWeekKey("2024-12-29")).toBe("2024-W52");
  });

  it("el 1-ene-2021 (viernes) pertenece a la W53 de 2020", () => {
    expect(isoWeekKey("2021-01-01")).toBe("2020-W53");
  });
});

describe("downsampleWeekly", () => {
  /** Genera n días LABORABLES consecutivos desde una fecha (como una serie bursátil) */
  function tradingDays(startISO: string, n: number) {
    const points = [];
    const cursor = new Date(`${startISO}T00:00:00Z`);
    while (points.length < n) {
      const dow = cursor.getUTCDay();
      if (dow !== 0 && dow !== 6) {
        points.push({
          date: cursor.toISOString().split("T")[0],
          value: 100 + points.length,
          invested: 100,
          cumFlow: 100,
        });
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return points;
  }

  it("serie ≤730 días: se devuelve intacta (misma referencia)", () => {
    const points = tradingDays("2024-01-01", 300); // ~60 semanas < 730 días
    expect(downsampleWeekly(points)).toBe(points);
  });

  it("1.300 días bursátiles (~5 años) → ~260 cierres semanales", () => {
    // 1.300 laborables desde el lunes 2020-01-06 = 260 semanas completas
    const points = tradingDays("2020-01-06", 1300);
    const result = downsampleWeekly(points);
    // 260 viernes + el primer punto (lunes 06-ene, no es cierre de su semana)
    expect(result).toHaveLength(261);
    expect(result[0]).toEqual(points[0]);
    expect(result[result.length - 1]).toEqual(points[points.length - 1]);
    // Todos los representantes (salvo el primero preservado) son viernes
    const fridays = result.slice(1).filter(
      (p) => new Date(`${p.date}T00:00:00Z`).getUTCDay() === 5
    );
    expect(fridays).toHaveLength(260);
  });

  it("el valor de cada semana es su ÚLTIMA observación, no un promedio", () => {
    const points = tradingDays("2020-01-06", 1300);
    const result = downsampleWeekly(points);
    // La primera semana completa: lunes 06 (value 100) ... viernes 10 (value 104)
    const w02 = result.find((p) => p.date === "2020-01-10");
    expect(w02?.value).toBe(104);
  });

  it("series con huecos: cada punto aislado conserva su semana", () => {
    const points = [
      { date: "2020-01-06", value: 1, invested: 1, cumFlow: 1 },
      { date: "2021-03-15", value: 2, invested: 1, cumFlow: 1 },
      { date: "2022-06-20", value: 3, invested: 1, cumFlow: 1 },
      { date: "2022-06-24", value: 4, invested: 1, cumFlow: 1 }, // misma semana que el anterior
    ];
    const result = downsampleWeekly(points);
    expect(result.map((p) => p.value)).toEqual([1, 2, 4]);
  });

  it("una serie que ya es semanal apenas cambia (idempotencia práctica)", () => {
    const daily = tradingDays("2020-01-06", 1300);
    const weekly = downsampleWeekly(daily);
    expect(downsampleWeekly(weekly)).toEqual(weekly);
  });
});

describe("computeEvolution aplica downsampling solo en rangos largos", () => {
  it("un histórico diario de ~3 años sale semanal", () => {
    const prices = new Map<string, number>();
    const cursor = new Date("2021-01-04T00:00:00Z");
    let value = 100;
    while (prices.size < 780) { // ~3 años de días laborables
      const dow = cursor.getUTCDay();
      if (dow !== 0 && dow !== 6) prices.set(cursor.toISOString().split("T")[0], value++);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const histories: PriceHistories = new Map([["A", prices]]);
    const txs: EngineTransaction[] = [
      { instrumentId: "A", type: "BUY", shares: 1, pricePerShare: 100, tradeDate: "2021-01-04" },
    ];
    const result = computeEvolution([{ instrumentId: "A", avgCost: 100 }], histories, txs);
    // 780 laborables = 156 semanas; el primer punto es lunes (se preserva aparte)
    expect(result.length).toBeLessThanOrEqual(157);
    expect(result.length).toBeGreaterThan(150);

    // downsample:false conserva la resolución completa (consumidores
    // analíticos: /metrics anualiza asumiendo puntos diarios — review C)
    const full = computeEvolution(
      [{ instrumentId: "A", avgCost: 100 }],
      histories,
      txs,
      { downsample: false }
    );
    expect(full).toHaveLength(780);
  });
});

describe("forwardFillHistories", () => {
  it("arrastra el último precio conocido y usa avgCost antes del primero", () => {
    const dates = [d1, d2, d3, d4, d5];
    const filled = forwardFillHistories(instruments, makePrices(), dates);
    expect([...filled.get("A")!.values()]).toEqual([10, 10, 12, 12, 11]);
    // B no tiene precio en d1 → avgCost (50)
    expect([...filled.get("B")!.values()]).toEqual([50, 50, 50, 55, 55]);
  });

  it("instrumento sin histórico: avgCost en todas las fechas", () => {
    const dates = [d1, d2];
    const sinHistorico: PriceHistories = new Map();
    const filled = forwardFillHistories([{ instrumentId: "C", avgCost: 7 }], sinHistorico, dates);
    expect([...filled.get("C")!.values()]).toEqual([7, 7]);
  });
});

// ============================================
// Fase E.3 — conversión a divisa base (paso previo puro)
// ============================================
//
// Fixture de dos divisas, cartera en EUR, derivado a mano. Tipos BCE
// (USD por 1 EUR) elegidos redondos para poder comprobarlo de cabeza:
//   vie 2026-01-02: 1,25 → 100 $ = 80 €
//   lun 2026-01-05: 1,00 → 100 $ = 100 €
//   mar 2026-01-06: 1,10 → 110 $ = 100 €
// A (EUR): 10 → 11 → 12 €.   B (USD): 100 → 100 → 110 $.
// BUY 10 A a 10 € y BUY 1 B a 100 $ el 02-ene (= 80 €).
//   02-ene: valor 100 + 80 = 180 · aportado 180
//   05-ene: valor 110 + 100 = 210 (B no se movió en $, pero el dólar subió)
//   06-ene: valor 120 + 100 = 220 (B +10% en $, el dólar −10%: 0 en €)

import { applyFxToEngineInputs, type EngineFx } from "./evolution-engine";
import { buildFxTable } from "./fx-utils";

describe("applyFxToEngineInputs — conversión a divisa base (E.3)", () => {
  const fx: EngineFx = {
    base: "EUR",
    table: buildFxTable([
      { date: "2026-01-02", quote: "USD", rate: 1.25 },
      { date: "2026-01-05", quote: "USD", rate: 1.0 },
      { date: "2026-01-06", quote: "USD", rate: 1.1 },
    ]),
  };
  const instruments = [
    { instrumentId: "A", avgCost: 10, currency: "EUR", label: "A" },
    { instrumentId: "B", avgCost: 100, currency: "USD", avgCostBase: 80, label: "B" },
  ];
  const histories = new Map([
    ["A", new Map([["2026-01-02", 10], ["2026-01-05", 11], ["2026-01-06", 12]])],
    ["B", new Map([["2026-01-02", 100], ["2026-01-05", 100], ["2026-01-06", 110]])],
  ]);
  const txs = [
    { instrumentId: "A", type: "BUY" as const, shares: 10, pricePerShare: 10, tradeDate: "2026-01-02" },
    { instrumentId: "B", type: "BUY" as const, shares: 1, pricePerShare: 100, tradeDate: "2026-01-02" },
  ];

  it("precios del instrumento en USD convertidos al tipo DE CADA DÍA; los EUR intactos", () => {
    const r = applyFxToEngineInputs(instruments, histories, txs, fx);
    const b = [...r.priceHistories.get("B")!.values()];
    [80, 100, 100].forEach((expected, i) => expect(b[i]).toBeCloseTo(expected, 10));
    expect(r.priceHistories.get("A")).toBe(histories.get("A"));
  });

  it("pricePerShare convertido al tipo de su tradeDate (100 $ el 02-ene = 80 €)", () => {
    const r = applyFxToEngineInputs(instruments, histories, txs, fx);
    expect(r.transactions[1].pricePerShare).toBeCloseTo(80, 10);
    expect(r.transactions[0]).toBe(txs[0]);
  });

  it("curva completa en EUR derivada a mano: 180 → 210 → 220 con aportado 180", () => {
    const r = applyFxToEngineInputs(instruments, histories, txs, fx);
    const evo = computeEvolution(r.instruments, r.priceHistories, r.transactions, { downsample: false });
    expect(evo.map((p) => [p.date, p.value, p.invested, p.cumFlow])).toEqual([
      ["2026-01-02", 180, 180, 180],
      ["2026-01-05", 210, 180, 180],
      ["2026-01-06", 220, 180, 180],
    ]);
  });

  it("transacción en domingo: forward-fill con el tipo del viernes (100 $ = 80 €)", () => {
    const sunday = [{ instrumentId: "B", type: "BUY" as const, shares: 1, pricePerShare: 100, tradeDate: "2026-01-04" }];
    expect(applyFxToEngineInputs(instruments, histories, sunday, fx).transactions[0].pricePerShare).toBeCloseTo(80, 10);
  });

  it("cumFlow en base: comprar a 1,25 y vender a 1,10 → entra 80 €, sale 100 €", () => {
    const roundTrip = [
      ...txs,
      { instrumentId: "B", type: "SELL" as const, shares: 0.5, pricePerShare: 110, tradeDate: "2026-01-06" },
    ];
    const r = applyFxToEngineInputs(instruments, histories, roundTrip, fx);
    const evo = computeEvolution(r.instruments, r.priceHistories, r.transactions, { downsample: false });
    // 180 aportados − 0,5 × 100 € de la venta = 130
    expect(evo.at(-1)!.cumFlow).toBeCloseTo(130, 2);
    // valor: 10 × 12 + 0,5 × 100 = 170
    expect(evo.at(-1)!.value).toBeCloseTo(170, 2);
  });

  it("fallback antes del primer precio: usa avgCostBase si existe", () => {
    const r = applyFxToEngineInputs(instruments, histories, txs, fx);
    expect(r.instruments[1].avgCost).toBe(80);
    expect(r.instruments[0]).toBe(instruments[0]);
  });

  it("fallback sin avgCostBase: avgCost convertido al tipo de la última fecha con precio (100 $ / 1,10)", () => {
    const noBase = [instruments[0], { ...instruments[1], avgCostBase: null }];
    expect(applyFxToEngineInputs(noBase, histories, txs, fx).instruments[1].avgCost).toBeCloseTo(90.909091, 6);
  });

  it("divisa sin tipos (JPY): se queda en su divisa y la cobertura lo declara", () => {
    const withYen = [...instruments, { instrumentId: "C", avgCost: 1000, currency: "JPY", label: "7203.T" }];
    const h = new Map([...histories, ["C", new Map([["2026-01-05", 1000]])]]);
    const r = applyFxToEngineInputs(withYen, h, txs, fx);
    expect(r.priceHistories.get("C")!.get("2026-01-05")).toBe(1000);
    expect(r.coverage.coverage).toBeCloseTo(2 / 3, 10);
    expect(r.coverage.missing).toEqual([{ instrument: "7203.T", currency: "JPY" }]);
  });

  it("todo en la divisa base: devuelve las mismas entradas y cobertura total", () => {
    const eur = [instruments[0]];
    const h = new Map([["A", histories.get("A")!]]);
    const r = applyFxToEngineInputs(eur, h, [txs[0]], fx);
    expect(r.priceHistories.get("A")).toBe(h.get("A"));
    expect(r.transactions[0]).toBe(txs[0]);
    expect(r.coverage).toEqual({ coverage: 1, missing: [] });
  });
});
