/**
 * Tests de metrics-utils — Fase A.1
 *
 * MODO PROFESOR — ¿Cómo se eligieron los valores esperados?
 * Ninguno sale de ejecutar la implementación: todos están derivados a mano
 * (cadena Π(1+r_i)−1 del TWR, drawdown pico→valle, NPV=0 del XIRR) o
 * validados con un script Python independiente (statistics.stdev usa n−1,
 * igual que la implementación). El script y su salida están pegados en el
 * bloque de comentario de la sección de volatilidad/Sharpe.
 */
import { describe, it, expect } from "vitest";
import {
  calculatePortfolioMetrics,
  calculateXIRR,
  normalizePortfolioTWR,
  intervalReturn,
  enrichWithTWR,
  buildSignedCashflows,
  type EvolutionPoint,
  type CashflowEntry,
} from "@/lib/metrics-utils";
import { buildFxTable } from "@/lib/fx-utils";

/**
 * Serie con un depósito GRANDE intermedio (1.000€ sobre una cartera de ~100€).
 *
 * Derivación a mano de los sub-retornos (cashflow_t = invested_t − invested_{t−1}):
 *   d2: (110 − 0 − 100) / 100        = +0.10
 *   d3: (1110 − 1000 − 110) / 110    =  0      ← el depósito de 1.000 NO es retorno
 *   d4: (1110 − 0 − 1110) / 1110     =  0
 *   d5: (999 − 0 − 1110) / 1110      = −0.10
 *   TWR = 1.10 × 1 × 1 × 0.90 − 1 = 0.99 − 1 = −0.01
 *
 * El retorno simple (sin ajustar cashflows) sería 999/100 − 1 = +899%:
 * el depósito haría parecer una ganancia enorme donde en realidad hay pérdida.
 */
const serieConDeposito: EvolutionPoint[] = [
  { date: "2024-02-01", value: 100, invested: 100 },
  { date: "2024-02-02", value: 110, invested: 100 },
  { date: "2024-02-05", value: 1110, invested: 1100 },
  { date: "2024-02-06", value: 1110, invested: 1100 },
  { date: "2024-02-07", value: 999, invested: 1100 },
];

/**
 * Serie de referencia para volatilidad/Sharpe: 6 puntos → 5 retornos diarios
 * diseñados a mano [+2%, −1%, +3%, −2%, +1%], con un depósito de 500€ el día 4.
 *
 * Construcción (cada valor = valor_anterior × (1+r) + depósito):
 *   p0: v = 1000
 *   p1: v = 1000 × 1.02              = 1020           (r = +0.02)
 *   p2: v = 1020 × 0.99              = 1009.8         (r = −0.01)
 *   p3: v = 1009.8 × 1.03 + 500      = 1540.094       (r = +0.03, depósito 500)
 *   p4: v = 1540.094 × 0.98          = 1509.29212     (r = −0.02)
 *   p5: v = 1509.29212 × 1.01        = 1524.3850412   (r = +0.01)
 */
const serieReferencia: EvolutionPoint[] = [
  { date: "2024-03-01", value: 1000, invested: 1000 },
  { date: "2024-03-04", value: 1020, invested: 1000 },
  { date: "2024-03-05", value: 1009.8, invested: 1000 },
  { date: "2024-03-06", value: 1540.094, invested: 1500 },
  { date: "2024-03-07", value: 1509.29212, invested: 1500 },
  { date: "2024-03-08", value: 1524.3850412, invested: 1500 },
];

/** Serie plana: sin variación → volatilidad 0, TWR 0, drawdown 0. */
const seriePlana: EvolutionPoint[] = [
  { date: "2024-04-01", value: 1000, invested: 1000 },
  { date: "2024-04-02", value: 1000, invested: 1000 },
  { date: "2024-04-03", value: 1000, invested: 1000 },
  { date: "2024-04-04", value: 1000, invested: 1000 },
  { date: "2024-04-05", value: 1000, invested: 1000 },
];

describe("calculatePortfolioMetrics — TWR y anualización", () => {
  it("el TWR excluye un depósito grande intermedio (vs retorno simple)", () => {
    const m = calculatePortfolioMetrics(serieConDeposito);

    expect(m).not.toBeNull();
    // Derivación: Π(1+r_i) − 1 = 1.10 × 1 × 1 × 0.90 − 1 = −0.01
    // (el retorno simple 999/100 − 1 = +8.99 quedaría inflado por el depósito)
    expect(m!.twr).toBeCloseTo(-0.01, 10);
    expect(m!.tradingDays).toBe(5);
    // Sin cashflows/currentValue/currentDate no se calcula XIRR
    expect(m!.xirr).toBeNull();
  });

  it("con menos de 252 puntos, twrAnnualized es igual al TWR del periodo", () => {
    const m = calculatePortfolioMetrics(serieConDeposito);

    // 5 puntos < 252 → no se anualiza (extrapolar 4 días a un año sería absurdo)
    expect(m!.twrAnnualized).toBe(m!.twr);
  });

  it("con ≥252 puntos anualiza: 504 días con TWR +21% → +10% anual", () => {
    // 504 puntos (2 "años" de trading): valor plano en 1000 salvo el último
    // día, que sube a 1210. Las fechas no se parsean en estas métricas.
    const serie504: EvolutionPoint[] = Array.from({ length: 504 }, (_, i) => ({
      date: `dia-${i}`,
      value: i === 503 ? 1210 : 1000,
      invested: 1000,
    }));

    const m = calculatePortfolioMetrics(serie504);

    expect(m).not.toBeNull();
    expect(m!.tradingDays).toBe(504);
    // Derivación: 503 sub-retornos, todos 0 salvo el último = 210/1000 = 0.21
    expect(m!.twr).toBeCloseTo(0.21, 10);
    // Derivación: (1 + 0.21)^(252/504) − 1 = √1.21 − 1 = 1.1 − 1 = 0.10 exacto
    expect(m!.twrAnnualized).toBeCloseTo(0.1, 10);
    // El valor nunca cae por debajo del pico → drawdown 0
    expect(m!.maxDrawdown).toBe(0);
  });

  it("frontera exacta: con 252 puntos anualiza con exponente 252/252 = 1 (= TWR)", () => {
    // 252 puntos: valor plano en 1000 salvo el último día, que sube a 1210.
    const serie252: EvolutionPoint[] = Array.from({ length: 252 }, (_, i) => ({
      date: `dia-${i}`,
      value: i === 251 ? 1210 : 1000,
      invested: 1000,
    }));

    const m = calculatePortfolioMetrics(serie252);

    expect(m).not.toBeNull();
    expect(m!.tradingDays).toBe(252);
    // Derivación: TWR = 210/1000 = 0.21. tradingDays = 252 entra en la rama
    // de anualización (>= 252), pero el exponente es 252/252 = 1:
    //   (1 + 0.21)^1 − 1 = 0.21 → twrAnnualized = twr.
    // La transición no-anualizar → anualizar es continua en la frontera
    // (con 251 puntos la otra rama también devolvería 0.21).
    expect(m!.twr).toBeCloseTo(0.21, 10);
    expect(m!.twrAnnualized).toBeCloseTo(0.21, 10);
    expect(m!.twrAnnualized).toBeCloseTo(m!.twr, 12);
  });
});

describe("calculatePortfolioMetrics — requisitos mínimos de datos", () => {
  it("devuelve null con solo 4 puntos válidos (mínimo: 5)", () => {
    const cuatroPuntos = serieConDeposito.slice(0, 4);
    expect(calculatePortfolioMetrics(cuatroPuntos)).toBeNull();
  });

  it("devuelve null con un array vacío", () => {
    expect(calculatePortfolioMetrics([])).toBeNull();
  });

  it("filtra los puntos con value <= 0 del inicio (antes de la 1ª inversión)", () => {
    // Dos días "vacíos" antes de la primera compra: no deben envenenar el TWR
    // (un salto 0 → 100 sería división por cero / retorno infinito)
    const conCerosIniciales: EvolutionPoint[] = [
      { date: "2024-01-30", value: 0, invested: 0 },
      { date: "2024-01-31", value: 0, invested: 0 },
      ...serieConDeposito,
    ];

    const m = calculatePortfolioMetrics(conCerosIniciales);

    expect(m).not.toBeNull();
    // Solo cuentan los 5 puntos con value > 0
    expect(m!.tradingDays).toBe(5);
    // Mismo TWR que sin los ceros: −0.01 (derivado arriba)
    expect(m!.twr).toBeCloseTo(-0.01, 10);
  });

  it("devuelve null si tras filtrar ceros quedan menos de 5 puntos", () => {
    const pocosValidos: EvolutionPoint[] = [
      { date: "2024-01-30", value: 0, invested: 0 },
      { date: "2024-01-31", value: 0, invested: 0 },
      ...serieConDeposito.slice(0, 4),
    ];
    expect(calculatePortfolioMetrics(pocosValidos)).toBeNull();
  });
});

describe("value = 0 en MEDIO de la serie (liquidación total + redepósito)", () => {
  /**
   * Cartera que se liquida por completo y se refinancia al día siguiente:
   * buy 100 → sube a 110 → sell TODO @110 (cumFlow 100 − 110 = −10) →
   * buy 200 (cumFlow 190) → +5% → +5%.
   *
   * El filter(d => d.value > 0) elimina el cero también en MEDIO de la serie,
   * empalmando dos días no adyacentes: (110, cumFlow 100) con (200, cumFlow 190).
   *
   * ✅ ANTES (⚠️ DISCREPANCIA histórica, cashflow = Δinvested): el empalme
   * 100 → 200 de invested daba cashflow 100 y un sub-retorno espurio de
   * −9.0909% → TWR 0.1025. Con cumFlow ACUMULADO, el Δ del empalme
   * (190 − 100 = 90) es exactamente venta (−110) + recompra (+200) neteadas
   * → sub-retorno (200 − 90 − 110)/110 = 0 → la cadena verdadera
   * 1.10 × 1.05 × 1.05 − 1 = 0.21275. El fix repara el empalme "gratis".
   */
  const serieConLiquidacion: EvolutionPoint[] = [
    { date: "2024-06-03", value: 100, invested: 100, cumFlow: 100 },
    { date: "2024-06-04", value: 110, invested: 100, cumFlow: 100 },
    { date: "2024-06-05", value: 0, invested: 0, cumFlow: -10 }, // liquidación total @110
    { date: "2024-06-06", value: 200, invested: 200, cumFlow: 190 }, // redepósito
    { date: "2024-06-07", value: 210, invested: 200, cumFlow: 190 },
    { date: "2024-06-10", value: 220.5, invested: 200, cumFlow: 190 },
  ];

  it("el empalme tras filtrar el cero ya NO genera retorno espurio: TWR 0.21275", () => {
    // Derivación: 1.10 × 1 (empalme) × 1.05 × 1.05 − 1 = 0.21275
    // (comportamiento anterior fijado en su día: 0.1025 — corregido aquí)
    const m = calculatePortfolioMetrics(serieConLiquidacion);

    expect(m).not.toBeNull();
    expect(m!.tradingDays).toBe(5); // el punto a 0 no cuenta como día válido
    expect(m!.twr).toBeCloseTo(0.21275, 10);
  });

  it("normalizePortfolioTWR mantiene la curva en 110 tras el redepósito", () => {
    // Derivación: [100, 110, 110 (empalme, retorno 0), 115.5, 121.275]
    // (curva anterior: [100, 110, 100, 105, 110.25] — el −9.09% espurio ya no está)
    const curva = normalizePortfolioTWR(serieConLiquidacion);

    expect(curva).toHaveLength(5);
    expect(curva[0]).toEqual({ date: "2024-06-03", value: 100 });
    expect(curva[1].value).toBeCloseTo(110, 8);
    expect(curva[2].value).toBeCloseTo(110, 8); // empalme sin retorno espurio
    expect(curva[3].value).toBeCloseTo(115.5, 8);
    expect(curva[4].value).toBeCloseTo(121.275, 8);
  });
});

describe("retiradas (cashflow negativo) en TWR, volatilidad y normalización", () => {
  /**
   * Serie con una RETIRADA de 500€ el día 3 (invested baja 1000 → 500).
   * Derivación de los sub-retornos (cashflow_t = invested_t − invested_{t−1}):
   *   d2: (1100 − 0 − 1000)/1000               = +0.10
   *   d3: cashflow = 500 − 1000 = −500
   *       (600 − (−500) − 1100)/1100 = 0/1100  =  0   ← la caída 1100→600 NO es pérdida
   *   d4: (630 − 0 − 600)/600                  = +0.05
   *   d5: (567 − 0 − 630)/630                  = −0.10
   */
  const serieConRetirada: EvolutionPoint[] = [
    { date: "2024-07-01", value: 1000, invested: 1000 },
    { date: "2024-07-02", value: 1100, invested: 1000 },
    { date: "2024-07-03", value: 600, invested: 500 },
    { date: "2024-07-04", value: 630, invested: 500 },
    { date: "2024-07-05", value: 567, invested: 500 },
  ];

  it("la retirada no cuenta como pérdida en el TWR", () => {
    const m = calculatePortfolioMetrics(serieConRetirada);

    expect(m).not.toBeNull();
    // Derivación: Π(1+r_i) − 1 = 1.10 × 1 × 1.05 × 0.90 − 1 = 1.0395 − 1 = 0.0395
    // (el retorno simple 567/1000 − 1 = −43.3% confundiría la retirada con pérdida)
    expect(m!.twr).toBeCloseTo(0.0395, 10);
  });

  it("la retirada no infla la volatilidad", () => {
    // Retornos ajustados: [0.10, 0, 0.05, −0.10]. Sin ajuste por cashflow, el
    // día de la retirada aportaría un falso −45.45% ((600−1100)/1100) que
    // dispararía σ. Referencia Python (py -3):
    //   statistics.stdev([0.1, 0.0, 0.05, -0.1]) * math.sqrt(252)
    //   = 1.3555441711725962
    const m = calculatePortfolioMetrics(serieConRetirada);
    expect(m!.volatility).toBeCloseTo(1.3555441711725962, 10);
  });

  it("normalizePortfolioTWR no desinfla la curva base 100 con la retirada", () => {
    // Derivación: [100, 110, 110 (retirada → retorno 0), 115.5, 103.95]
    const curva = normalizePortfolioTWR(serieConRetirada);

    expect(curva).toHaveLength(5);
    expect(curva[1].value).toBeCloseTo(110, 8);
    expect(curva[2].value).toBeCloseTo(110, 8); // ¡no cae a ~54.5!
    expect(curva[3].value).toBeCloseTo(115.5, 8);
    expect(curva[4].value).toBeCloseTo(103.95, 8);
  });
});

/*
 * Valores de referencia de volatilidad/Sharpe calculados con Python
 * (módulo statistics: stdev muestral n−1, igual que la implementación).
 *
 * --- Script ejecutado (py -3) -------------------------------------------
 * import statistics, math
 *
 * returns = [0.02, -0.01, 0.03, -0.02, 0.01]
 * twr = math.prod(1 + r for r in returns) - 1
 * sd = statistics.stdev(returns)          # stdev muestral (n-1)
 * vol = sd * math.sqrt(252)               # anualizada
 * sharpe_rf0 = twr / vol                  # rf = 0 (twrAnnualized == twr, <252 días)
 * sharpe_rf2 = (twr - 0.02) / vol         # rf = 2%
 * print("twr        =", repr(twr))
 * print("stdev(n-1) =", repr(sd))
 * print("vol_anual  =", repr(vol))
 * print("sharpe rf0 =", repr(sharpe_rf0))
 * print("sharpe rf2 =", repr(sharpe_rf2))
 *
 * --- Salida ---------------------------------------------------------------
 * twr        = 0.02948504120000006
 * stdev(n-1) = 0.020736441353327723
 * vol_anual  = 0.3291808013842849
 * sharpe rf0 = 0.08957096244984011
 * sharpe rf2 = 0.028814077735132695
 *
 * Comprobación manual de la varianza: media = 0.03/5 = 0.006;
 * desviaciones [0.014, −0.016, 0.024, −0.026, 0.004];
 * Σd² = 0.00172; var = 0.00172/4 = 0.00043; σ = √0.00043 ≈ 0.0207364.
 */
describe("volatilidad y Sharpe — validados contra referencia Python", () => {
  it("volatilidad anualizada con retornos ajustados por cashflow", () => {
    const m = calculatePortfolioMetrics(serieReferencia);

    expect(m).not.toBeNull();
    expect(m!.tradingDays).toBe(6);
    // Referencia Python: stdev([0.02,−0.01,0.03,−0.02,0.01]) × √252
    expect(m!.volatility).toBeCloseTo(0.3291808013842849, 10);
    // TWR = 1.02×0.99×1.03×0.98×1.01 − 1 (referencia Python: 0.0294850412)
    expect(m!.twr).toBeCloseTo(0.0294850412, 10);
  });

  it("el depósito de 500€ no infla la volatilidad", () => {
    // Sin ajuste por cashflow, el salto 1009.8 → 1540.094 parecería un retorno
    // del +52.5% diario y dispararía la volatilidad muy por encima del 33%.
    const m = calculatePortfolioMetrics(serieReferencia);
    expect(m!.volatility).toBeLessThan(0.4);
  });

  it("Sharpe con rf = 0: TWR del periodo / volatilidad", () => {
    const m = calculatePortfolioMetrics(serieReferencia, 0);

    // Derivación: <252 días → twrAnnualized = twr = 0.0294850412
    // sharpe = 0.0294850412 / 0.3291808014 = 0.0895709624 (referencia Python)
    expect(m!.sharpe).toBeCloseTo(0.08957096244984011, 9);
  });

  it("Sharpe con rf = 2% resta la tasa libre de riesgo", () => {
    const m = calculatePortfolioMetrics(serieReferencia, 0.02);

    // Derivación: (0.0294850412 − 0.02) / 0.3291808014 = 0.0288140777 (Python)
    expect(m!.sharpe).toBeCloseTo(0.028814077735132695, 9);
  });

  it("Sharpe negativo cuando rf supera el rendimiento (rf = 5% > TWR 2.95%)", () => {
    const m = calculatePortfolioMetrics(serieReferencia, 0.05);

    // Derivación (py -3, mismos retornos que arriba):
    //   (0.02948504120000006 − 0.05) / 0.32918080138428535
    //   = −0.06232124933692836
    // El numerador es negativo (rf > twrAnnualized) y σ > 0 → Sharpe < 0.
    expect(m!.sharpe).toBeLessThan(0);
    expect(m!.sharpe).toBeCloseTo(-0.06232124933692836, 9);
  });

  it("Sharpe = 0 cuando la volatilidad es 0 (incluso con rf > 0)", () => {
    // Serie plana: todos los retornos 0 → σ = 0. Dividir entre 0 no tiene
    // sentido; la implementación devuelve 0, no −Infinity ni NaN.
    const m = calculatePortfolioMetrics(seriePlana, 0.02);

    expect(m).not.toBeNull();
    expect(m!.volatility).toBe(0);
    expect(m!.sharpe).toBe(0);
    expect(m!.twr).toBeCloseTo(0, 12);
  });
});

describe("Max Drawdown", () => {
  it("serie pico→valle→recuperación 100→120→90→130: MDD = −25%", () => {
    // Derivación: pico = 120; valle = 90; MDD = (90 − 120)/120 = −0.25.
    // La recuperación posterior a 130 NO borra el drawdown ya sufrido.
    const serie: EvolutionPoint[] = [
      { date: "2024-05-01", value: 100, invested: 100 },
      { date: "2024-05-02", value: 120, invested: 100 },
      { date: "2024-05-03", value: 90, invested: 100 },
      { date: "2024-05-06", value: 130, invested: 100 },
      { date: "2024-05-07", value: 130, invested: 100 },
    ];

    const m = calculatePortfolioMetrics(serie);

    expect(m).not.toBeNull();
    expect(m!.maxDrawdown).toBeCloseTo(-0.25, 10);
    // Sin cashflows, el TWR coincide con el retorno simple: 130/100 − 1 = 0.30
    expect(m!.twr).toBeCloseTo(0.3, 10);
  });

  it("toma la mayor caída de la serie de referencia: −2%", () => {
    // Caídas desde pico: 1009.8 vs pico 1020 → −1%;
    // 1509.29212 vs pico 1540.094 → −30.80188/1540.094 = −2%. Mayor: −2%.
    const m = calculatePortfolioMetrics(serieReferencia);
    expect(m!.maxDrawdown).toBeCloseTo(-0.02, 10);
  });
});

describe("normalizePortfolioTWR", () => {
  it("serie vacía → []", () => {
    expect(normalizePortfolioTWR([])).toEqual([]);
  });

  it("serie sin ningún punto con value > 0 → []", () => {
    const todoCeros: EvolutionPoint[] = [
      { date: "2024-01-01", value: 0, invested: 0 },
      { date: "2024-01-02", value: 0, invested: 0 },
    ];
    expect(normalizePortfolioTWR(todoCeros)).toEqual([]);
  });

  it("la curva empieza exactamente en 100 y conserva las fechas", () => {
    const resultado = normalizePortfolioTWR(serieConDeposito);

    expect(resultado).toHaveLength(5);
    expect(resultado[0]).toEqual({ date: "2024-02-01", value: 100 });
    expect(resultado[4].date).toBe("2024-02-07");
  });

  it("los depósitos no inflan la curva base 100", () => {
    // Derivación (misma cadena que el TWR de serieConDeposito):
    //   d1: 100
    //   d2: 100 × 1.10 = 110
    //   d3: depósito de 1.000 con retorno 0 → sigue en 110 (¡no 1.110!)
    //   d4: retorno 0 → 110
    //   d5: 110 × 0.90 = 99
    const resultado = normalizePortfolioTWR(serieConDeposito);

    expect(resultado[1].value).toBeCloseTo(110, 8);
    expect(resultado[2].value).toBeCloseTo(110, 8);
    expect(resultado[3].value).toBeCloseTo(110, 8);
    expect(resultado[4].value).toBeCloseTo(99, 8);
  });

  it("filtra los ceros iniciales y arranca en 100 en el primer día válido", () => {
    const conCeros: EvolutionPoint[] = [
      { date: "2024-01-30", value: 0, invested: 0 },
      ...serieConDeposito,
    ];

    const resultado = normalizePortfolioTWR(conCeros);

    expect(resultado).toHaveLength(5);
    expect(resultado[0]).toEqual({ date: "2024-02-01", value: 100 });
  });
});

/*
 * Referencias Python para los casos multi-cashflow de XIRR (Newton manual,
 * misma convención t = días/365 que la implementación; scipy no necesario).
 *
 * --- Script ejecutado (py -3) -------------------------------------------
 * from datetime import date
 *
 * def xirr(flows):
 *     d0 = flows[0][0]
 *     ts = [(d - d0).days / 365 for d, _ in flows]
 *     r = 0.1
 *     for _ in range(300):
 *         npv  = sum(a / (1 + r) ** t for (_, a), t in zip(flows, ts))
 *         dnpv = sum(-t * a / (1 + r) ** (t + 1) for (_, a), t in zip(flows, ts))
 *         r_new = r - npv / dnpv
 *         if abs(r_new - r) < 1e-13:
 *             return r_new
 *         r = r_new
 *     return r
 *
 * A = [(date(2022,1,1), -10000), (date(2022,7,1), -5000), (date(2023,1,1), 17000)]
 * B = [(date(2022,1,1), -10000), (date(2022,7,1),  2000), (date(2023,1,1),  9500)]
 * print((date(2022,7,1)-date(2022,1,1)).days)   # días del tramo intermedio
 * print(repr(xirr(A)))
 * print(repr(xirr(B)))
 *
 * --- Salida ---------------------------------------------------------------
 * 181
 * 0.16093584964263574
 * 0.1661095412131129
 *
 * Comprobación manual del caso A en r = 0.1609:
 * NPV = −10000 − 5000/(1.1609)^(181/365) + 17000/1.1609 ≈ 0 ✓
 * (2022 no es bisiesto: ninguna fecha cruza un 29 de febrero)
 */
describe("calculateXIRR", () => {
  it("inversión única: −10.000 → 11.000 en 365 días = 10% anual", () => {
    // Derivación: NPV(r) = −10000 + 11000/(1+r)^(365/365) = 0
    //   → 1 + r = 11000/10000 = 1.1 → r = 0.10
    const cashflows: CashflowEntry[] = [
      { date: "2021-01-01", amount: -10000 },
    ];

    const xirr = calculateXIRR(cashflows, 11000, "2022-01-01");

    expect(xirr).not.toBeNull();
    expect(xirr!).toBeCloseTo(0.1, 6);
  });

  it("pérdida: −10.000 → 9.000 en 365 días = −10% anual", () => {
    // Derivación: −10000 + 9000/(1+r) = 0 → 1+r = 0.9 → r = −0.10
    const cashflows: CashflowEntry[] = [
      { date: "2021-01-01", amount: -10000 },
    ];

    const xirr = calculateXIRR(cashflows, 9000, "2022-01-01");

    expect(xirr!).toBeCloseTo(-0.1, 6);
  });

  it("multi-cashflow: dos inversiones escalonadas (referencia Python)", () => {
    // −10.000 el 2022-01-01, −5.000 el 2022-07-01 (día 181), valor final
    // 17.000 el 2023-01-01 (día 365). Raíz de
    //   −10000 − 5000/(1+r)^(181/365) + 17000/(1+r) = 0
    // Referencia Python (Newton): r = 0.16093584964263574
    const cashflows: CashflowEntry[] = [
      { date: "2022-01-01", amount: -10000 },
      { date: "2022-07-01", amount: -5000 },
    ];

    const xirr = calculateXIRR(cashflows, 17000, "2023-01-01");

    expect(xirr!).toBeCloseTo(0.16093584964263574, 6);
  });

  it("multi-cashflow: con retirada intermedia (referencia Python)", () => {
    // −10.000 el 2022-01-01, retirada de +2.000 el 2022-07-01, valor final
    // 9.500 el 2023-01-01. Raíz de
    //   −10000 + 2000/(1+r)^(181/365) + 9500/(1+r) = 0
    // Referencia Python (Newton): r = 0.1661095412131129
    const cashflows: CashflowEntry[] = [
      { date: "2022-01-01", amount: -10000 },
      { date: "2022-07-01", amount: 2000 },
    ];

    const xirr = calculateXIRR(cashflows, 9500, "2023-01-01");

    expect(xirr!).toBeCloseTo(0.1661095412131129, 6);
  });

  it("año bisiesto: 366 días con convención t = días/365 → r ≠ 10% exacto", () => {
    // 2024 es bisiesto: del 2024-01-01 al 2025-01-01 hay 366 días (JS Date
    // parsea YYYY-MM-DD como UTC y cuenta el 29 de febrero). La implementación
    // usa la convención Actual/365 fija:
    //   NPV(r) = −10000 + 11000/(1+r)^(366/365) = 0
    //   → (1+r)^(366/365) = 1.1 → r = 1.1^(365/366) − 1
    // Referencia Python (py -3): 1.1**(365/366) - 1 = 0.09971358593414137
    // (con convención días/366 saldría 0.10 exacto; este test fija que el día
    // extra del año bisiesto SÍ reduce la tasa anualizada)
    const cashflows: CashflowEntry[] = [
      { date: "2024-01-01", amount: -10000 },
    ];

    const xirr = calculateXIRR(cashflows, 11000, "2025-01-01");

    expect(xirr).not.toBeNull();
    expect(xirr!).toBeCloseTo(0.09971358593414137, 6);
    // La diferencia con 0.10 (~2.9e−4) es real, no ruido del solver (tol 1e−7)
    expect(Math.abs(xirr! - 0.1)).toBeGreaterThan(1e-4);
  });

  it("cashflows vacíos → null", () => {
    expect(calculateXIRR([], 11000, "2022-01-01")).toBeNull();
  });

  it("currentValue = 0 → null", () => {
    const cashflows: CashflowEntry[] = [
      { date: "2021-01-01", amount: -10000 },
    ];
    expect(calculateXIRR(cashflows, 0, "2022-01-01")).toBeNull();
  });

  it("currentValue negativo → null", () => {
    const cashflows: CashflowEntry[] = [
      { date: "2021-01-01", amount: -10000 },
    ];
    expect(calculateXIRR(cashflows, -500, "2022-01-01")).toBeNull();
  });

  it("todos los flujos el mismo día → null (no existe TIR)", () => {
    // Derivación: con t = 0 para todos los flujos, NPV(r) = −1000 + 1100 = 100
    // para CUALQUIER r (no depende de la tasa) → no hay raíz → null.
    const cashflows: CashflowEntry[] = [
      { date: "2021-01-01", amount: -1000 },
    ];
    expect(calculateXIRR(cashflows, 1100, "2021-01-01")).toBeNull();
  });

  it("sin cambio de signo (solo entradas positivas) → null", () => {
    // Derivación: NPV(r) = 1000 + 1000/(1+r) > 1000 para todo r > −1.
    // Una TIR exige al menos un flujo de cada signo; aquí no existe raíz.
    const cashflows: CashflowEntry[] = [
      { date: "2021-01-01", amount: 1000 },
    ];
    expect(calculateXIRR(cashflows, 1000, "2022-01-01")).toBeNull();
  });

  it("horizonte absurdo (200 años) sin raíz → null por divergencia numérica", () => {
    // Derivación: de nuevo solo flujos positivos → no existe TIR.
    // Además, con t ≈ 200 años el solver acaba evaluando (1+100)^200, que
    // desborda a Infinity → corta por la guarda de divergencia y devuelve null.
    const cashflows: CashflowEntry[] = [
      { date: "1900-01-01", amount: 1000 },
    ];
    expect(calculateXIRR(cashflows, 1000, "2100-01-01")).toBeNull();
  });

  it("pérdida casi total: −10.000 → 200 en un año = −98% anual", () => {
    // Derivación: −10000 + 200/(1+r) = 0 → 1+r = 0.02 → r = −0.98
    // (Newton pasa por el clamp en −0.99 y vuelve a converger hacia −0.98)
    const cashflows: CashflowEntry[] = [
      { date: "2021-01-01", amount: -10000 },
    ];

    const xirr = calculateXIRR(cashflows, 200, "2022-01-01");

    expect(xirr!).toBeCloseTo(-0.98, 6);
  });

  it("pérdida más allá del −99% anual → null (limitación documentada)", () => {
    // Derivación: −10000 + 1/(1+r) = 0 → r = −0.9999 (−99.99%).
    // ⚠️ DISCREPANCIA (leve, numérica — no fiscal): la TIR existe
    // matemáticamente (−99.99%), pero el solver acota la tasa al rango
    // [−0.99, 100] para evitar divergencias numéricas, así que nunca puede
    // alcanzar la raíz y devuelve null. Comportamiento actual documentado.
    const cashflows: CashflowEntry[] = [
      { date: "2021-01-01", amount: -10000 },
    ];

    expect(calculateXIRR(cashflows, 1, "2022-01-01")).toBeNull();
  });
});

/*
 * VENTAS CON PLUSVALÍA/MINUSVALÍA — el bug que motivó la micro-fase
 * fix-twr-cashflows, ya CORREGIDO con cumFlow.
 *
 * Historia: el cashflow del intervalo era Δinvested, e `invested` es el COST
 * BASIS del replay del motor: una venta retira el coste medio de las
 * participaciones vendidas, NO los ingresos reales. Con plusvalía, la
 * diferencia aparecía como pérdida fantasma en el sub-retorno; con
 * minusvalía, como ganancia fantasma. El commit de caracterización de esta
 * micro-fase fijó esa salida errónea; este commit añade cumFlow (flujo neto
 * acumulado a PRECIOS DE TRANSACCIÓN) a los fixtures y reescribe las
 * expectativas a los valores económicos correctos, re-derivados a mano y
 * verificados con un script Node independiente.
 *
 * Los valores erróneos que salían antes quedan anotados en cada caso (son el
 * "diff de producción" de la micro-fase). La venta A COSTE EXACTO
 * (proceeds = coste retirado) nunca disparó el bug — serieConRetirada
 * (arriba, sin cumFlow) conserva sus valores de siempre por eso mismo.
 */
describe("ventas con plusvalía/minusvalía — corregido con cumFlow (fix-twr-cashflows)", () => {
  /**
   * Venta PARCIAL con plusvalía: buy 1.000sh@10 → el precio dobla a 20 →
   * sell 500@20 (proceeds 10.000; coste retirado 500×10 = 5.000) → +5% → plano.
   *
   * cumFlow: 10000 → 10000 → 0 (10000 − 10000) → 0 → 0
   *
   * Sub-retornos (cashflow = ΔcumFlow):
   *   d2: (20000 − 0 − 10000)/10000                    = +1.00
   *   d3: cashflow = 0 − 10000 = −10000 (ingresos REALES de la venta)
   *       (10000 + 10000 − 20000)/20000                = 0   ← vender no es perder
   *   d4: (10500 − 0 − 10000)/10000                    = +0.05
   *   d5: 0
   *   TWR = 2 × 1 × 1.05 − 1 = +1.10
   *
   * ANTES (Δinvested = −5000): sub-retorno fantasma de −25% en d3 → TWR 0.575.
   */
  const serieVentaParcialPlusvalia: EvolutionPoint[] = [
    { date: "2024-08-01", value: 10000, invested: 10000, cumFlow: 10000 },
    { date: "2024-08-02", value: 20000, invested: 10000, cumFlow: 10000 },
    { date: "2024-08-05", value: 10000, invested: 5000, cumFlow: 0 },
    { date: "2024-08-06", value: 10500, invested: 5000, cumFlow: 0 },
    { date: "2024-08-07", value: 10500, invested: 5000, cumFlow: 0 },
  ];

  /**
   * Venta TOTAL con plusvalía — el caso del ticket. Un 2º instrumento (1.000€
   * plano) mantiene la serie con value > 0 tras la venta.
   *
   * A: buy 10.000 → dobla a 20.000 → sell TODO @20.000 · B: 1.000 plano.
   * cumFlow: 11000 → 11000 → −9000 (11000 − 20000) → −9000 → −9000
   *
   * Sub-retornos:
   *   d2: (21000 − 0 − 11000)/11000                    = +10/11 (+90,909…%)
   *   d3: cashflow = −9000 − 11000 = −20000 (los ingresos reales, no el coste)
   *       (1000 + 20000 − 21000)/21000                 = 0
   *   d4, d5: 0
   *   TWR = 21/11 − 1 = +0.909090…
   *
   * ANTES (Δinvested = −10000): sub-retorno fantasma de −10/21 → TWR 0
   * (¡borraba TODA la ganancia — exactamente lo que describe el ticket!).
   */
  const serieVentaTotalPlusvalia: EvolutionPoint[] = [
    { date: "2024-09-02", value: 11000, invested: 11000, cumFlow: 11000 },
    { date: "2024-09-03", value: 21000, invested: 11000, cumFlow: 11000 },
    { date: "2024-09-04", value: 1000, invested: 1000, cumFlow: -9000 },
    { date: "2024-09-05", value: 1000, invested: 1000, cumFlow: -9000 },
    { date: "2024-09-06", value: 1000, invested: 1000, cumFlow: -9000 },
  ];

  /**
   * Venta parcial con MINUSVALÍA (el fantasma cambiaba de signo): buy
   * 1.000sh@10 → cae a 8 → sell 500@8 (proceeds 4.000; coste retirado 5.000).
   *
   * cumFlow: 10000 → 10000 → 6000 (10000 − 4000) → 6000 → 6000
   *
   * Sub-retornos:
   *   d2: (8000 − 0 − 10000)/10000                     = −0.20
   *   d3: cashflow = 6000 − 10000 = −4000
   *       (4000 + 4000 − 8000)/8000                    = 0
   *   d4, d5: 0
   *   TWR = 0.8 − 1 = −0.20 (la caída real; vender no la "cura")
   *
   * ANTES (Δinvested = −5000): ganancia fantasma de +12.5% → TWR −0.10
   * (mostraba la MITAD de la pérdida real).
   */
  const serieVentaMinusvalia: EvolutionPoint[] = [
    { date: "2024-10-01", value: 10000, invested: 10000, cumFlow: 10000 },
    { date: "2024-10-02", value: 8000, invested: 10000, cumFlow: 10000 },
    { date: "2024-10-03", value: 4000, invested: 5000, cumFlow: 6000 },
    { date: "2024-10-04", value: 4000, invested: 5000, cumFlow: 6000 },
    { date: "2024-10-07", value: 4000, invested: 5000, cumFlow: 6000 },
  ];

  it("venta parcial con plusvalía: TWR +110% (antes 0.575 por la pérdida fantasma)", () => {
    const m = calculatePortfolioMetrics(serieVentaParcialPlusvalia);
    expect(m).not.toBeNull();
    expect(m!.twr).toBeCloseTo(1.1, 10);
  });

  it("venta parcial con plusvalía: la volatilidad ya no incluye el −25% espurio", () => {
    // Retornos [1, 0, 0.05, 0] → stdev(n−1) × √252 = 7.81392986915035
    // (antes [1, −0.25, 0.05, 0] → 8.71894489…: el fantasma metía casi un
    // punto entero de σ anualizada). Referencia del script Node de la micro-fase.
    const m = calculatePortfolioMetrics(serieVentaParcialPlusvalia);
    expect(m!.volatility).toBeCloseTo(7.81392986915035, 10);
  });

  it("venta parcial con plusvalía: la curva base 100 no cae al vender", () => {
    // Curva: [100, 200, 200, 210, 210] (antes: [100, 200, 150, 157.5, 157.5])
    const curva = normalizePortfolioTWR(serieVentaParcialPlusvalia);
    expect(curva).toHaveLength(5);
    expect(curva[1].value).toBeCloseTo(200, 8);
    expect(curva[2].value).toBeCloseTo(200, 8);
    expect(curva[4].value).toBeCloseTo(210, 8);
  });

  it("venta total con plusvalía (ticket): el TWR conserva el +90,9% ganado", () => {
    const m = calculatePortfolioMetrics(serieVentaTotalPlusvalia);
    expect(m).not.toBeNull();
    // 21/11 − 1 = 0.909090… (antes: 0 — la venta borraba toda la ganancia)
    expect(m!.twr).toBeCloseTo(10 / 11, 10);
  });

  it("venta total con plusvalía: la curva base 100 se mantiene tras la venta", () => {
    // Curva: [100, 190.909…, 190.909…, …] (antes caía a 100)
    const curva = normalizePortfolioTWR(serieVentaTotalPlusvalia);
    expect(curva[1].value).toBeCloseTo(190.9090909090909, 8);
    expect(curva[2].value).toBeCloseTo(190.9090909090909, 8);
    expect(curva[4].value).toBeCloseTo(190.9090909090909, 8);
  });

  it("venta con minusvalía: TWR −20% real (antes −10% por la ganancia fantasma)", () => {
    const m = calculatePortfolioMetrics(serieVentaMinusvalia);
    expect(m).not.toBeNull();
    expect(m!.twr).toBeCloseTo(-0.2, 10);
  });

  it("FALLBACK legado: sin cumFlow, Δinvested reproduce el comportamiento antiguo", () => {
    // La misma serie SIN cumFlow cae al fallback Δinvested y devuelve el valor
    // erróneo caracterizado (0.575). Documenta que el fallback existe y cuál
    // es su límite: solo es correcto cuando no hay ventas.
    const sinCumFlow: EvolutionPoint[] = serieVentaParcialPlusvalia.map(
      ({ date, value, invested }) => ({ date, value, invested })
    );
    const m = calculatePortfolioMetrics(sinCumFlow);
    expect(m!.twr).toBeCloseTo(0.575, 10);
  });
});

describe("intervalReturn — helper único del TWR (política de ceros y cashflow)", () => {
  it("prev.value <= 0 → null (sin base sobre la que medir)", () => {
    expect(intervalReturn({ value: 0, cumFlow: 0 }, { value: 100, cumFlow: 100 })).toBeNull();
    expect(intervalReturn({ value: -5, cumFlow: 0 }, { value: 100, cumFlow: 100 })).toBeNull();
  });

  it("usa ΔcumFlow cuando ambos puntos lo traen", () => {
    // (110 − (100 − 100) − 100)/100 = 0.10
    expect(
      intervalReturn(
        { value: 100, invested: 100, cumFlow: 100 },
        { value: 110, invested: 100, cumFlow: 100 }
      )
    ).toBeCloseTo(0.1, 12);
    // Venta con plusvalía: cashflow real −110 → (0 + 110 − 110)/110 = 0
    expect(
      intervalReturn(
        { value: 110, invested: 100, cumFlow: 100 },
        { value: 0, invested: 0, cumFlow: -10 }
      )
    ).toBeCloseTo(0, 12);
  });

  it("cae a Δinvested si CUALQUIERA de los dos puntos no trae cumFlow", () => {
    // prev sin cumFlow: (105 − (120 − 100) − 100)/100 = −0.15
    expect(
      intervalReturn({ value: 100, invested: 100 }, { value: 105, invested: 120, cumFlow: 120 })
    ).toBeCloseTo(-0.15, 12);
    // curr sin cumFlow: mismo resultado por la misma vía
    expect(
      intervalReturn({ value: 100, invested: 100, cumFlow: 100 }, { value: 105, invested: 120 })
    ).toBeCloseTo(-0.15, 12);
  });

  it("sin invested ni cumFlow: cashflow 0 (retorno simple)", () => {
    expect(intervalReturn({ value: 100 }, { value: 110 })).toBeCloseTo(0.1, 12);
  });
});

describe("enrichWithTWR — TWR acumulado por punto (serie de display)", () => {
  it("decora cada punto con el TWR acumulado y no filtra ceros", () => {
    // El caso del ticket SIN 2º instrumento: vender todo deja value 0 y el
    // punto SE CONSERVA (la serie pintada necesita twr en cada punto).
    // cumFlow: compra 10000; venta total @20000 → −10000.
    const serie = [
      { date: "2024-11-01", value: 10000, invested: 10000, cumFlow: 10000 },
      { date: "2024-11-04", value: 20000, invested: 10000, cumFlow: 10000 },
      { date: "2024-11-05", value: 0, invested: 0, cumFlow: -10000 },
    ];
    const enriched = enrichWithTWR(serie);

    expect(enriched).toHaveLength(3);
    expect(enriched[0].twr).toBeCloseTo(0, 12);
    expect(enriched[1].twr).toBeCloseTo(1.0, 12); // +100%
    // Venta total: cashflow = −10000 − 10000 = −20000 →
    // (0 + 20000 − 20000)/20000 = 0 → el TWR SE QUEDA en +100%.
    // ANTES (Δinvested = −10000): sub-retorno −50% → el header mostraba 0%.
    expect(enriched[2].twr).toBeCloseTo(1.0, 12);
    // Los campos originales se conservan (spread)
    expect(enriched[2].value).toBe(0);
    expect(enriched[2].date).toBe("2024-11-05");
  });

  it("tras un punto a 0, el acumulado se arrastra (no se resetea)", () => {
    const serie = [
      { date: "d1", value: 100, invested: 100, cumFlow: 100 },
      { date: "d2", value: 110, invested: 100, cumFlow: 100 },
      { date: "d3", value: 0, invested: 0, cumFlow: -10 }, // liquidación @110
      { date: "d4", value: 200, invested: 200, cumFlow: 190 }, // redepósito
    ];
    const enriched = enrichWithTWR(serie);

    expect(enriched[1].twr).toBeCloseTo(0.1, 12);
    expect(enriched[2].twr).toBeCloseTo(0.1, 12); // liquidación: retorno 0, arrastra
    // d3→d4: prev.value = 0 → intervalo sin base (null) → sigue en +10%
    expect(enriched[3].twr).toBeCloseTo(0.1, 12);
  });

  it("serie vacía → []", () => {
    expect(enrichWithTWR([])).toEqual([]);
  });
});

describe("buildSignedCashflows — serie del XIRR (helper de los 2 endpoints de métricas)", () => {
  it("BUY y TRANSFER_IN son inversiones (negativo); SELL y TRANSFER_OUT retiradas (positivo)", () => {
    const cashflows = buildSignedCashflows([
      { tradeDate: new Date("2024-01-02T00:00:00Z"), type: "BUY", shares: 10, pricePerShare: 100 },
      { tradeDate: new Date("2024-02-05T00:00:00Z"), type: "TRANSFER_IN", shares: 5, pricePerShare: 200 },
      { tradeDate: new Date("2024-03-04T00:00:00Z"), type: "SELL", shares: 4, pricePerShare: 150 },
      { tradeDate: new Date("2024-04-01T00:00:00Z"), type: "TRANSFER_OUT", shares: 2, pricePerShare: 180 },
    ]);

    expect(cashflows).toEqual([
      { date: "2024-01-02", amount: -1000 },
      { date: "2024-02-05", amount: -1000 },
      { date: "2024-03-04", amount: 600 },
      { date: "2024-04-01", amount: 360 },
    ]);
  });

  it("acepta Prisma Decimal (objetos convertibles con Number())", () => {
    // Prisma Decimal implementa toString(); Number() lo convierte igual que
    // hacía el inline de los endpoints (lección: Decimal SIEMPRE con Number())
    const decimalLike = (n: number) => ({ toString: () => String(n) });
    const [cf] = buildSignedCashflows([
      {
        tradeDate: new Date("2024-05-06T00:00:00Z"),
        type: "BUY",
        shares: decimalLike(2.5),
        pricePerShare: decimalLike(10.4),
      },
    ]);
    expect(cf).toEqual({ date: "2024-05-06", amount: -26 });
  });

  it("la fecha es el día UTC del tradeDate (misma convención que el motor)", () => {
    // Un tradeDate con hora tardía no puede "saltar" de día: se toma la parte
    // de fecha del ISO UTC, igual que hacía el inline
    const [cf] = buildSignedCashflows([
      {
        tradeDate: new Date("2024-06-10T23:30:00Z"),
        type: "SELL",
        shares: 1,
        pricePerShare: 50,
      },
    ]);
    expect(cf.date).toBe("2024-06-10");
  });

  it("array vacío → []", () => {
    expect(buildSignedCashflows([])).toEqual([]);
  });

  // ── D.1: fees y dividendos en la serie (definición honesta del MWR) ──

  it("las comisiones encarecen la compra y recortan la venta", () => {
    // BUY 10×100 con 5€ de comisión: salieron 1.005€ de tu bolsillo.
    // SELL 4×150 con 5€ de comisión: te ingresaron 595€.
    // (Antes de D.1: −1000 y +600 — las comisiones no existían para el XIRR.)
    const cashflows = buildSignedCashflows([
      { tradeDate: new Date("2024-01-02T00:00:00Z"), type: "BUY", shares: 10, pricePerShare: 100, fees: 5 },
      { tradeDate: new Date("2024-03-04T00:00:00Z"), type: "SELL", shares: 4, pricePerShare: 150, fees: 5 },
    ]);
    expect(cashflows).toEqual([
      { date: "2024-01-02", amount: -1005 },
      { date: "2024-03-04", amount: 595 },
    ]);
  });

  it("sin fees explícitos se asume 0 (compatible con las queries antiguas)", () => {
    const [cf] = buildSignedCashflows([
      { tradeDate: new Date("2024-01-02T00:00:00Z"), type: "BUY", shares: 10, pricePerShare: 100 },
    ]);
    expect(cf.amount).toBe(-1000);
  });

  it("DIVIDEND: flujo positivo neto = bruto − retención", () => {
    const [cf] = buildSignedCashflows([
      {
        tradeDate: new Date("2024-06-03T00:00:00Z"),
        type: "DIVIDEND",
        shares: 38,
        pricePerShare: 0.2429,
        grossAmount: 250,
        withholdingTax: 50,
        totalAmount: 250,
      },
    ]);
    expect(cf).toEqual({ date: "2024-06-03", amount: 200 });
  });

  it("DIVIDEND antiguo sin grossAmount: usa totalAmount (regla de aggregate-tax-summary)", () => {
    // Forma real de los DIVIDEND de la BD: gross_amount NULL, total_amount
    // = shares × precio (38 × 0,2429 = 9,23). Misma regla que la vista
    // fiscal global → cero divergencia entre MWR y fiscalidad.
    const [cf] = buildSignedCashflows([
      {
        tradeDate: new Date("2025-03-10T00:00:00Z"),
        type: "DIVIDEND",
        shares: 38,
        pricePerShare: 0.2429,
        grossAmount: null,
        withholdingTax: null,
        totalAmount: 9.23,
      },
    ]);
    expect(cf).toEqual({ date: "2025-03-10", amount: 9.23 });
  });

  it("XIRR sobre la serie con dividendo coincide con la referencia derivada a mano", () => {
    // Mismos números que el caso "retirada intermedia" de calculateXIRR
    // (referencia Python: 0.1661095412131129): compra de 10.000 el
    // 2022-01-01, dividendo NETO de 2.000 el 2022-07-01 (bruto 2.500,
    // retención 500), valor final 9.500 el 2023-01-01. Para el solver, el
    // dividendo neto es un flujo positivo idéntico a la retirada de 2.000
    // de aquel caso — misma raíz.
    const cashflows = buildSignedCashflows([
      { tradeDate: new Date("2022-01-01T00:00:00Z"), type: "BUY", shares: 100, pricePerShare: 100 },
      {
        tradeDate: new Date("2022-07-01T00:00:00Z"),
        type: "DIVIDEND",
        shares: 100,
        pricePerShare: 25,
        grossAmount: 2500,
        withholdingTax: 500,
        totalAmount: 2500,
      },
    ]);
    const xirr = calculateXIRR(cashflows, 9500, "2023-01-01");
    expect(xirr).not.toBeNull();
    expect(xirr!).toBeCloseTo(0.1661095412131129, 6);
  });
});

describe("calculatePortfolioMetrics — XIRR integrado", () => {
  it("calcula el XIRR cuando se pasan cashflows, currentValue y currentDate", () => {
    // Derivación del XIRR: −10000 + 11000/(1+r) = 0 → r = 0.10 (caso 365 días)
    const cashflows: CashflowEntry[] = [
      { date: "2021-01-01", amount: -10000 },
    ];

    const m = calculatePortfolioMetrics(
      serieReferencia,
      0,
      cashflows,
      11000,
      "2022-01-01"
    );

    expect(m).not.toBeNull();
    expect(m!.xirr).not.toBeNull();
    expect(m!.xirr!).toBeCloseTo(0.1, 6);
  });

  it("xirr queda en null si falta currentValue", () => {
    const cashflows: CashflowEntry[] = [
      { date: "2021-01-01", amount: -10000 },
    ];

    const m = calculatePortfolioMetrics(serieReferencia, 0, cashflows);

    expect(m).not.toBeNull();
    expect(m!.xirr).toBeNull();
  });

  it("xirr queda en null si falta currentDate", () => {
    const cashflows: CashflowEntry[] = [
      { date: "2021-01-01", amount: -10000 },
    ];

    const m = calculatePortfolioMetrics(serieReferencia, 0, cashflows, 11000);

    expect(m).not.toBeNull();
    expect(m!.xirr).toBeNull();
  });
});

// ============================================
// Fase E.3 — flujos del XIRR en divisa base
// ============================================
// Tipos BCE (divisa por 1 EUR) del 02-ene-2026: USD 1,25 · CAD 1,6
//   BUY 2 × 100 CA$ + 4 CA$ de comisión → −204 CA$ / 1,6 = −127,50 €
//   DIVIDEND bruto 10 $ − retención 1,5 $ → 8,5 $ / 1,25 = +6,80 €
describe("buildSignedCashflows con fx (E.3)", () => {
  const fx = {
    base: "EUR",
    table: buildFxTable([
      { date: "2026-01-02", quote: "USD", rate: 1.25 },
      { date: "2026-01-02", quote: "CAD", rate: 1.6 },
    ]),
  };
  const day = new Date("2026-01-02T00:00:00Z");
  const buyCad = { tradeDate: day, type: "BUY", shares: 2, pricePerShare: 100, fees: 4, currency: "CAD" };
  const divUsd = {
    tradeDate: day, type: "DIVIDEND", shares: 1, pricePerShare: 0,
    grossAmount: 10, withholdingTax: 1.5, totalAmount: 8.5, currency: "USD",
  };
  const buyEur = { tradeDate: day, type: "BUY", shares: 1, pricePerShare: 50, fees: 0, currency: "EUR" };

  it("compra en CAD con comisión: −127,50 €", () => {
    const [cf] = buildSignedCashflows([buyCad], fx);
    expect(cf.amount).toBeCloseTo(-127.5, 10);
    expect(cf.converted).toBe(true);
  });

  it("dividendo neto en USD: +6,80 €", () => {
    expect(buildSignedCashflows([divUsd], fx)[0].amount).toBeCloseTo(6.8, 10);
  });

  it("flujo en la divisa base: intacto y convertido", () => {
    expect(buildSignedCashflows([buyEur], fx)[0]).toEqual({ date: "2026-01-02", amount: -50, converted: true });
  });

  it("sin tipo (JPY): importe original y converted false", () => {
    const yen = { ...buyEur, currency: "JPY", pricePerShare: 1000 };
    expect(buildSignedCashflows([yen], fx)[0]).toEqual({ date: "2026-01-02", amount: -1000, converted: false });
  });

  it("sin fx: exactamente el comportamiento de antes (sin campo converted)", () => {
    expect(buildSignedCashflows([buyCad])).toEqual([{ date: "2026-01-02", amount: -204 }]);
  });

  it("el XIRR cambia con la divisa: comprar a 1,25 y valer lo mismo en $ a 1,10 es ganar en €", () => {
    const fxTable = buildFxTable([
      { date: "2025-01-02", quote: "USD", rate: 1.25 },
      { date: "2026-01-02", quote: "USD", rate: 1.1 },
    ]);
    const buy = { tradeDate: new Date("2025-01-02T00:00:00Z"), type: "BUY", shares: 1, pricePerShare: 1000, fees: 0, currency: "USD" };
    const flows = buildSignedCashflows([buy], { base: "EUR", table: fxTable });
    // 1.000 $ comprados a 1,25 = 800 €; hoy valen 1.000 $ / 1,10 = 909,09 € → +13,6% en un año
    const xirr = calculateXIRR(flows, 1000 / 1.1, "2026-01-02");
    expect(xirr).toBeCloseTo(909.0909 / 800 - 1, 3);
  });
});
