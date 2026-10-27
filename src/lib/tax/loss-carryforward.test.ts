/**
 * Tests de loss-carryforward.ts — Fase A.1
 *
 * MODO PROFESOR — ¿Qué estamos verificando aquí?
 *
 * El arrastre de pérdidas (Art. 49 Ley 35/2006 del IRPF) permite que las
 * pérdidas de un año compensen ganancias de los 4 años SIGUIENTES, en orden
 * FIFO (las más antiguas primero). Es como una cola con TTL: cada pérdida
 * "vive" hasta originYear + 4 y después caduca.
 *
 * Todos los valores esperados están derivados A MANO desde la regla fiscal
 * (nunca copiados de la salida del código). Las derivaciones van en
 * comentarios encima de cada test.
 *
 * ⚠️ NOTA FISCAL (simplificación documentada del módulo):
 * En el IRPF real la base del ahorro tiene DOS compartimentos separados
 * (ganancias/pérdidas patrimoniales vs. rendimientos del capital mobiliario,
 * p.ej. dividendos), y el saldo negativo de uno solo compensa hasta el 25%
 * del saldo positivo del otro (Art. 49.1 LIRPF). Este módulo SIMPLIFICA
 * agrupando todo en un único saldo (grossIncome = gains + dividends), sin el
 * límite del 25%. Los tests documentan el comportamiento actual del módulo.
 */
import { describe, it, expect } from "vitest";
import {
  calculateWithLossCarryforward,
  type AnnualFiscalRaw,
} from "@/lib/tax/loss-carryforward";

describe("calculateWithLossCarryforward", () => {
  // ─── Caso base: pérdida compensada al año siguiente ──────────────

  it("compensa la pérdida de un año con las ganancias del año siguiente", () => {
    // Derivación:
    //   2022: neto = (1.000 + 0) - 4.000 = -3.000 → pool: 3.000€ (caduca 2026)
    //   2023: neto = 5.000 → compensa 3.000 de 2022
    //         base ajustada = 5.000 - 3.000 = 2.000; pool queda vacío
    const data: AnnualFiscalRaw[] = [
      { year: 2022, totalGains: 1000, deductibleLosses: 4000, grossDividends: 0 },
      { year: 2023, totalGains: 5000, deductibleLosses: 0, grossDividends: 0 },
    ];

    const result = calculateWithLossCarryforward(data, 2023);

    expect(result.originalTaxableBase).toBe(5000);
    expect(result.compensatedFromPriorYears).toBe(3000);
    expect(result.compensationDetails).toEqual([
      { originYear: 2022, amount: 3000 },
    ]);
    expect(result.adjustedTaxableBase).toBe(2000);
    expect(result.remainingCarryforward).toBe(0);
    expect(result.remainingDetails).toEqual([]);
  });

  // ─── Expiración a 4 años: ambos lados de la frontera ─────────────

  it("una pérdida de 2020 sigue siendo usable en 2024 (año límite, inclusive)", () => {
    // Derivación:
    //   2020: neto = -5.000 → pool: 5.000€, expiresYear = 2020 + 4 = 2024
    //   2024: la poda usa expiresYear < year → 2024 < 2024 es falso → NO caduca
    //         compensa min(5.000, 2.000) = 2.000 → base ajustada = 0
    //         pool restante = 5.000 - 2.000 = 3.000
    const data: AnnualFiscalRaw[] = [
      { year: 2020, totalGains: 0, deductibleLosses: 5000, grossDividends: 0 },
      { year: 2024, totalGains: 2000, deductibleLosses: 0, grossDividends: 0 },
    ];

    const result = calculateWithLossCarryforward(data, 2024);

    expect(result.originalTaxableBase).toBe(2000);
    expect(result.compensatedFromPriorYears).toBe(2000);
    expect(result.compensationDetails).toEqual([
      { originYear: 2020, amount: 2000 },
    ]);
    expect(result.adjustedTaxableBase).toBe(0);
    expect(result.remainingCarryforward).toBe(3000);
    expect(result.remainingDetails).toEqual([
      {
        originYear: 2020,
        originalAmount: 5000,
        remainingAmount: 3000,
        expiresYear: 2024,
      },
    ]);
  });

  it("una pérdida de 2020 ya NO es usable en 2025 (caducada)", () => {
    // Derivación:
    //   2020: pool 5.000€, expiresYear = 2024
    //   2025: poda → 2024 < 2025 es cierto → la pérdida se elimina ANTES de compensar
    //         base ajustada = 2.000 sin compensación alguna
    const data: AnnualFiscalRaw[] = [
      { year: 2020, totalGains: 0, deductibleLosses: 5000, grossDividends: 0 },
      { year: 2025, totalGains: 2000, deductibleLosses: 0, grossDividends: 0 },
    ];

    const result = calculateWithLossCarryforward(data, 2025);

    expect(result.originalTaxableBase).toBe(2000);
    expect(result.compensatedFromPriorYears).toBe(0);
    expect(result.compensationDetails).toEqual([]);
    expect(result.adjustedTaxableBase).toBe(2000);
    expect(result.remainingCarryforward).toBe(0);
    expect(result.remainingDetails).toEqual([]);
  });

  // ─── Compensación parcial multi-año (FIFO con varios orígenes) ───

  // Dataset compartido para los tres tests siguientes.
  // Derivación de la evolución del pool, año a año:
  //   2020: neto = -10.000 → pool: [2020: 10.000 (exp. 2024)]
  //   2021: neto = -2.000  → pool: [2020: 10.000, 2021: 2.000 (exp. 2025)]
  //   2022: neto = +4.000  → FIFO: consume 4.000 de 2020
  //                          pool: [2020: 6.000, 2021: 2.000]
  //   2023: neto = +5.000  → FIFO: consume 5.000 de 2020
  //                          pool: [2020: 1.000, 2021: 2.000]
  //   2024: neto = +4.000  → 2020 no caduca aún (exp. 2024 no < 2024)
  //                          FIFO: 1.000 de 2020 + 2.000 de 2021 = 3.000
  //                          base ajustada = 4.000 - 3.000 = 1.000; pool vacío
  const multiYearData: AnnualFiscalRaw[] = [
    { year: 2020, totalGains: 0, deductibleLosses: 10000, grossDividends: 0 },
    { year: 2021, totalGains: 0, deductibleLosses: 2000, grossDividends: 0 },
    { year: 2022, totalGains: 4000, deductibleLosses: 0, grossDividends: 0 },
    { year: 2023, totalGains: 5000, deductibleLosses: 0, grossDividends: 0 },
    { year: 2024, totalGains: 4000, deductibleLosses: 0, grossDividends: 0 },
  ];

  it("pérdida grande: primer año de consumo parcial deja pool de dos orígenes (2022)", () => {
    // Derivación (ver tabla arriba): en 2022 se compensan 4.000 solo de 2020
    // (FIFO: la de 2021 no se toca porque la de 2020 cubre todo el neto).
    // Pool restante = 6.000 (2020) + 2.000 (2021) = 8.000
    const result = calculateWithLossCarryforward(multiYearData, 2022);

    expect(result.originalTaxableBase).toBe(4000);
    expect(result.compensatedFromPriorYears).toBe(4000);
    expect(result.compensationDetails).toEqual([
      { originYear: 2020, amount: 4000 },
    ]);
    expect(result.adjustedTaxableBase).toBe(0);
    expect(result.remainingCarryforward).toBe(8000);
    expect(result.remainingDetails).toEqual([
      {
        originYear: 2020,
        originalAmount: 10000,
        remainingAmount: 6000,
        expiresYear: 2024,
      },
      {
        originYear: 2021,
        originalAmount: 2000,
        remainingAmount: 2000,
        expiresYear: 2025,
      },
    ]);
  });

  it("pérdida grande: segundo año sigue consumiendo la más antigua primero (2023)", () => {
    // Derivación: en 2023 se compensan 5.000, TODOS de 2020 (FIFO).
    // Pool restante = 1.000 (2020) + 2.000 (2021) = 3.000
    const result = calculateWithLossCarryforward(multiYearData, 2023);

    expect(result.originalTaxableBase).toBe(5000);
    expect(result.compensatedFromPriorYears).toBe(5000);
    expect(result.compensationDetails).toEqual([
      { originYear: 2020, amount: 5000 },
    ]);
    expect(result.adjustedTaxableBase).toBe(0);
    expect(result.remainingCarryforward).toBe(3000);
    expect(result.remainingDetails).toEqual([
      {
        originYear: 2020,
        originalAmount: 10000,
        remainingAmount: 1000,
        expiresYear: 2024,
      },
      {
        originYear: 2021,
        originalAmount: 2000,
        remainingAmount: 2000,
        expiresYear: 2025,
      },
    ]);
  });

  it("pérdida grande: el último año agota varios orígenes en orden FIFO (2024)", () => {
    // Derivación: en 2024 quedan 1.000 (2020) + 2.000 (2021).
    // Compensación = 1.000 de 2020 + 2.000 de 2021 = 3.000
    // Base ajustada = 4.000 - 3.000 = 1.000; pool vacío.
    const result = calculateWithLossCarryforward(multiYearData, 2024);

    expect(result.originalTaxableBase).toBe(4000);
    expect(result.compensatedFromPriorYears).toBe(3000);
    expect(result.compensationDetails).toEqual([
      { originYear: 2020, amount: 1000 },
      { originYear: 2021, amount: 2000 },
    ]);
    expect(result.adjustedTaxableBase).toBe(1000);
    expect(result.remainingCarryforward).toBe(0);
    expect(result.remainingDetails).toEqual([]);
  });

  // ─── Año objetivo con neto negativo ──────────────────────────────

  it("un año objetivo con neto negativo devuelve base 0 y añade la pérdida al pool", () => {
    // Derivación:
    //   2020: neto = -500 → pool: [2020: 500 (exp. 2024)]
    //   2021: bruto = 200 + 100 = 300; neto = 300 - 1.500 = -1.200
    //         → pool: [2020: 500, 2021: 1.200 (exp. 2025)]
    //   Total arrastrable = 500 + 1.200 = 1.700
    const data: AnnualFiscalRaw[] = [
      { year: 2020, totalGains: 0, deductibleLosses: 500, grossDividends: 0 },
      { year: 2021, totalGains: 200, deductibleLosses: 1500, grossDividends: 100 },
    ];

    const result = calculateWithLossCarryforward(data, 2021);

    expect(result.originalTaxableBase).toBe(0);
    expect(result.compensatedFromPriorYears).toBe(0);
    expect(result.compensationDetails).toEqual([]);
    expect(result.adjustedTaxableBase).toBe(0);
    expect(result.remainingCarryforward).toBe(1700);
    expect(result.remainingDetails).toEqual([
      {
        originYear: 2020,
        originalAmount: 500,
        remainingAmount: 500,
        expiresYear: 2024,
      },
      {
        originYear: 2021,
        originalAmount: 1200,
        remainingAmount: 1200,
        expiresYear: 2025,
      },
    ]);
  });

  // ─── Dividendos en el ingreso bruto ──────────────────────────────

  it("los dividendos suman al ingreso bruto del año (grossIncome = gains + dividends)", () => {
    // Derivación:
    //   2022: neto = -1.000 → pool: 1.000€
    //   2023: bruto = 500 (ganancias) + 800 (dividendos) = 1.300
    //         compensa 1.000 → base ajustada = 1.300 - 1.000 = 300
    const data: AnnualFiscalRaw[] = [
      { year: 2022, totalGains: 0, deductibleLosses: 1000, grossDividends: 0 },
      { year: 2023, totalGains: 500, deductibleLosses: 0, grossDividends: 800 },
    ];

    const result = calculateWithLossCarryforward(data, 2023);

    expect(result.originalTaxableBase).toBe(1300);
    expect(result.compensatedFromPriorYears).toBe(1000);
    expect(result.compensationDetails).toEqual([
      { originYear: 2022, amount: 1000 },
    ]);
    expect(result.adjustedTaxableBase).toBe(300);
    expect(result.remainingCarryforward).toBe(0);
  });

  it("los dividendos absorben pérdidas del mismo año sin límite (simplificación del módulo)", () => {
    // ⚠️ DISCREPANCIA (documental, comportamiento actual intencionado):
    // En el IRPF real (Art. 49.1.b LIRPF), el saldo negativo de pérdidas
    // patrimoniales solo compensa rendimientos de capital mobiliario hasta
    // el 25% de su saldo positivo. Con estos datos, la ley diría:
    //   saldo GyP = 100 - 500 = -400; RCM = +600
    //   compensable contra RCM = min(400, 25% × 600) = 150
    //   base ahorro = 600 - 150 = 450, y quedarían 250 a arrastrar 4 años.
    // El módulo SIMPLIFICA agrupando todo:
    //   neto = (100 + 600) - 500 = 200 → base 200, nada al pool.
    // Documentamos el comportamiento actual del módulo (200, sin arrastre).
    const data: AnnualFiscalRaw[] = [
      { year: 2022, totalGains: 100, deductibleLosses: 500, grossDividends: 600 },
    ];

    const result = calculateWithLossCarryforward(data, 2022);

    expect(result.originalTaxableBase).toBe(200);
    expect(result.compensatedFromPriorYears).toBe(0);
    expect(result.adjustedTaxableBase).toBe(200);
    expect(result.remainingCarryforward).toBe(0);
    expect(result.remainingDetails).toEqual([]);
  });

  // ─── Robustez del input ──────────────────────────────────────────

  it("ordena internamente los años aunque el input llegue desordenado", () => {
    // Derivación: mismos datos que el caso base (pérdida 3.000 en 2022,
    // ganancia 5.000 en 2023), pero con 2023 ANTES de 2022 en el array.
    // El resultado debe ser idéntico: compensa 3.000 → base ajustada 2.000.
    const data: AnnualFiscalRaw[] = [
      { year: 2023, totalGains: 5000, deductibleLosses: 0, grossDividends: 0 },
      { year: 2022, totalGains: 1000, deductibleLosses: 4000, grossDividends: 0 },
    ];

    const result = calculateWithLossCarryforward(data, 2023);

    expect(result.originalTaxableBase).toBe(5000);
    expect(result.compensatedFromPriorYears).toBe(3000);
    expect(result.compensationDetails).toEqual([
      { originYear: 2022, amount: 3000 },
    ]);
    expect(result.adjustedTaxableBase).toBe(2000);
    expect(result.remainingCarryforward).toBe(0);
  });

  it("un año objetivo sin datos previos no tiene nada que compensar", () => {
    // Derivación: solo existe 2023 con neto = 1.000 → sin pool previo,
    // la base ajustada es igual a la original.
    const data: AnnualFiscalRaw[] = [
      { year: 2023, totalGains: 1000, deductibleLosses: 0, grossDividends: 0 },
    ];

    const result = calculateWithLossCarryforward(data, 2023);

    expect(result.originalTaxableBase).toBe(1000);
    expect(result.compensatedFromPriorYears).toBe(0);
    expect(result.compensationDetails).toEqual([]);
    expect(result.adjustedTaxableBase).toBe(1000);
    expect(result.remainingCarryforward).toBe(0);
    expect(result.remainingDetails).toEqual([]);
  });

  it("devuelve el resultado vacío si el año objetivo no aparece en los datos", () => {
    // El bucle recorre los años existentes pero nunca captura el objetivo
    // → se devuelve el resultado por defecto (todo a cero).
    const data: AnnualFiscalRaw[] = [
      { year: 2022, totalGains: 1000, deductibleLosses: 0, grossDividends: 0 },
    ];

    const result = calculateWithLossCarryforward(data, 2030);

    expect(result).toEqual({
      originalTaxableBase: 0,
      compensatedFromPriorYears: 0,
      compensationDetails: [],
      adjustedTaxableBase: 0,
      remainingCarryforward: 0,
      remainingDetails: [],
    });

    // Caso extremo: sin datos en absoluto.
    expect(calculateWithLossCarryforward([], 2023)).toEqual({
      originalTaxableBase: 0,
      compensatedFromPriorYears: 0,
      compensationDetails: [],
      adjustedTaxableBase: 0,
      remainingCarryforward: 0,
      remainingDetails: [],
    });
  });

  it("un neto exactamente cero va por la rama positiva y no añade nada al pool", () => {
    // Derivación:
    //   2022: neto = 1.000 - 1.000 = 0 → NO es pérdida (0 no es < 0),
    //         base original = 0 y el pool queda vacío.
    //   2023: neto = 500 sin nada que compensar → base ajustada = 500.
    const data: AnnualFiscalRaw[] = [
      { year: 2022, totalGains: 1000, deductibleLosses: 1000, grossDividends: 0 },
      { year: 2023, totalGains: 500, deductibleLosses: 0, grossDividends: 0 },
    ];

    const result2022 = calculateWithLossCarryforward(data, 2022);
    expect(result2022.originalTaxableBase).toBe(0);
    expect(result2022.adjustedTaxableBase).toBe(0);
    expect(result2022.remainingCarryforward).toBe(0);

    const result2023 = calculateWithLossCarryforward(data, 2023);
    expect(result2023.compensatedFromPriorYears).toBe(0);
    expect(result2023.adjustedTaxableBase).toBe(500);
  });

  // ─── Redondeo a 2 decimales ──────────────────────────────────────

  it("redondea a 2 decimales los importes de compensación y los restos del pool", () => {
    // Derivación (a mano, con los valores exactos):
    //   2022: neto = -1.000,337 → pool: 1.000,337€
    //   2023: neto = +500,111 → compensa min(1.000,337; 500,111) = 500,111
    //         → redondeado en el detalle: 500,11
    //         base original = round(500,111) = 500,11; base ajustada = 0
    //         resto del pool = 1.000,337 - 500,111 = 500,226 → round = 500,23
    //         originalAmount del pool = round(1.000,337) = 1.000,34
    const data: AnnualFiscalRaw[] = [
      { year: 2022, totalGains: 0, deductibleLosses: 1000.337, grossDividends: 0 },
      { year: 2023, totalGains: 500.111, deductibleLosses: 0, grossDividends: 0 },
    ];

    const result = calculateWithLossCarryforward(data, 2023);

    expect(result.originalTaxableBase).toBeCloseTo(500.11, 2);
    expect(result.compensatedFromPriorYears).toBeCloseTo(500.11, 2);
    expect(result.compensationDetails).toHaveLength(1);
    expect(result.compensationDetails[0].originYear).toBe(2022);
    expect(result.compensationDetails[0].amount).toBeCloseTo(500.11, 2);
    expect(result.adjustedTaxableBase).toBe(0);
    expect(result.remainingCarryforward).toBeCloseTo(500.23, 2);
    expect(result.remainingDetails).toHaveLength(1);
    expect(result.remainingDetails[0].originalAmount).toBeCloseTo(1000.34, 2);
    expect(result.remainingDetails[0].remainingAmount).toBeCloseTo(500.23, 2);
    expect(result.remainingDetails[0].expiresYear).toBe(2026);
  });

  it("neutraliza el ruido de coma flotante en la base (0.1 + 0.2)", () => {
    // MODO PROFESOR: en IEEE-754, 0.1 + 0.2 = 0.30000000000000004 (el clásico).
    // El módulo redondea con Math.round(x * 100) / 100, así que la base
    // debe salir 0,30 limpio, no 0,30000000000000004.
    // Derivación: bruto = 0,1 + 0,2 = 0,3; neto = 0,3 → base = 0,30.
    const data: AnnualFiscalRaw[] = [
      { year: 2023, totalGains: 0.1, deductibleLosses: 0, grossDividends: 0.2 },
    ];

    const result = calculateWithLossCarryforward(data, 2023);

    expect(result.originalTaxableBase).toBeCloseTo(0.3, 2);
    expect(result.adjustedTaxableBase).toBeCloseTo(0.3, 2);
    // Verificación estricta del redondeo: el valor almacenado es exactamente
    // el double más cercano a 0,3 (no el 0,30000000000000004 sin redondear).
    expect(result.originalTaxableBase).toBe(0.3);
  });

  // ─── Poda selectiva: caducada y viva conviven en el pool ─────────

  it("poda solo la pérdida caducada y compensa FIFO con la que sigue viva", () => {
    // Derivación:
    //   2019: neto = -3.000 → pool: [2019: 3.000 (exp. 2023)]
    //   2021: neto = -2.000 → pool: [2019: 3.000, 2021: 2.000 (exp. 2025)]
    //   2024: neto = +1.500 → poda: 2023 < 2024 → la de 2019 se elimina
    //         ENTERA antes de compensar (no debe aparecer en los detalles);
    //         la de 2021 sigue viva (2025 no < 2024).
    //         FIFO sobre el pool podado: compensa min(2.000, 1.500) = 1.500
    //         de 2021 → base ajustada = 0; resto = 2.000 - 1.500 = 500.
    const data: AnnualFiscalRaw[] = [
      { year: 2019, totalGains: 0, deductibleLosses: 3000, grossDividends: 0 },
      { year: 2021, totalGains: 0, deductibleLosses: 2000, grossDividends: 0 },
      { year: 2024, totalGains: 1500, deductibleLosses: 0, grossDividends: 0 },
    ];

    const result = calculateWithLossCarryforward(data, 2024);

    expect(result.originalTaxableBase).toBe(1500);
    expect(result.compensatedFromPriorYears).toBe(1500);
    // La pérdida caducada de 2019 NO aparece: solo compensa la de 2021.
    expect(result.compensationDetails).toEqual([
      { originYear: 2021, amount: 1500 },
    ]);
    expect(result.adjustedTaxableBase).toBe(0);
    expect(result.remainingCarryforward).toBe(500);
    expect(result.remainingDetails).toEqual([
      {
        originYear: 2021,
        originalAmount: 2000,
        remainingAmount: 500,
        expiresYear: 2025,
      },
    ]);
  });

  // ─── Resto parcial que caduca más tarde ──────────────────────────

  it("el resto de una pérdida parcialmente consumida desaparece al caducar", () => {
    // Derivación:
    //   2020: neto = -3.000 → pool: [2020: 3.000 (exp. 2024)]
    //   2022: neto = +1.000 → compensa 1.000 de 2020
    //         → pool: [2020: resto 2.000]
    //   2026: poda → 2024 < 2026 → el resto parcial de 2.000 se elimina
    //         antes de compensar → base ajustada = 500 sin compensación;
    //         pool vacío (el resto pendiente NO sobrevive a la caducidad).
    const data: AnnualFiscalRaw[] = [
      { year: 2020, totalGains: 0, deductibleLosses: 3000, grossDividends: 0 },
      { year: 2022, totalGains: 1000, deductibleLosses: 0, grossDividends: 0 },
      { year: 2026, totalGains: 500, deductibleLosses: 0, grossDividends: 0 },
    ];

    const result = calculateWithLossCarryforward(data, 2026);

    expect(result.originalTaxableBase).toBe(500);
    expect(result.compensatedFromPriorYears).toBe(0);
    expect(result.compensationDetails).toEqual([]);
    expect(result.adjustedTaxableBase).toBe(500);
    expect(result.remainingCarryforward).toBe(0);
    expect(result.remainingDetails).toEqual([]);
  });

  // ─── Asimetría de redondeo: la rama negativa no redondea ─────────

  it("con año objetivo negativo, el pool se reporta SIN redondear (asimetría actual)", () => {
    // ⚠️ ASIMETRÍA (comportamiento actual, no es regla fiscal): la rama
    // positiva redondea remainingCarryforward y remainingDetails a 2
    // decimales (Math.round(x*100)/100), pero la rama negativa los devuelve
    // crudos, con ruido IEEE-754 incluido.
    // Derivación (verificada con Node):
    //   2022: neto = -1.000,337 → pool: [2022: 1.000,337]
    //   2023: bruto = 0,1 + 0,2 = 0,30000000000000004 (clásico IEEE-754)
    //         neto = bruto - 0,7 = -0,3999999999999999 → rama negativa
    //         pool: [2022: 1.000,337; 2023: 0,3999999999999999]
    //         total crudo = 1.000,737 — la rama positiva habría reportado
    //         1.000,74 (round) y 0,4 en el detalle de 2023.
    const data: AnnualFiscalRaw[] = [
      { year: 2022, totalGains: 0, deductibleLosses: 1000.337, grossDividends: 0 },
      { year: 2023, totalGains: 0.1, deductibleLosses: 0.7, grossDividends: 0.2 },
    ];

    const result = calculateWithLossCarryforward(data, 2023);

    expect(result.originalTaxableBase).toBe(0);
    expect(result.adjustedTaxableBase).toBe(0);
    expect(result.remainingCarryforward).toBeCloseTo(1000.737, 3);
    // Sin redondear: NO es el 1.000,74 que daría la rama positiva.
    expect(result.remainingCarryforward).not.toBe(1000.74);
    expect(result.remainingDetails).toHaveLength(2);
    expect(result.remainingDetails[0].originYear).toBe(2022);
    expect(result.remainingDetails[0].remainingAmount).toBeCloseTo(1000.337, 3);
    expect(result.remainingDetails[1].originYear).toBe(2023);
    expect(result.remainingDetails[1].expiresYear).toBe(2027);
    expect(result.remainingDetails[1].remainingAmount).toBeCloseTo(0.4, 2);
    // El ruido flotante se conserva tal cual (0,3999... ≠ 0,4 exacto).
    expect(result.remainingDetails[1].remainingAmount).not.toBe(0.4);
  });

  // ─── Comportamiento actual: poda solo en años con neto positivo ──

  it("si el año objetivo es negativo, el pool NO poda las pérdidas ya caducadas", () => {
    // ⚠️ DISCREPANCIA: según el Art. 49 LIRPF, la pérdida de 2020 solo es
    // compensable hasta 2024; en 2025 está caducada y el arrastre pendiente
    // real debería ser solo 1.000€ (la pérdida de 2025). Sin embargo, la
    // implementación solo poda el pool cuando procesa un año con neto ≥ 0,
    // así que con año objetivo negativo el remainingCarryforward incluye la
    // pérdida caducada de 2020 (5.000 + 1.000 = 6.000). La pérdida caducada
    // nunca llega a compensar (se podaría en el siguiente año positivo), pero
    // el importe "pendiente" reportado queda sobrestimado.
    // Derivación del comportamiento ACTUAL:
    //   2020: neto = -5.000 → pool: [2020: 5.000 (exp. 2024)]
    //   2025: neto = -1.000 → rama negativa, sin poda
    //         → pool: [2020: 5.000, 2025: 1.000] → total reportado = 6.000
    const data: AnnualFiscalRaw[] = [
      { year: 2020, totalGains: 0, deductibleLosses: 5000, grossDividends: 0 },
      { year: 2025, totalGains: 0, deductibleLosses: 1000, grossDividends: 0 },
    ];

    const result = calculateWithLossCarryforward(data, 2025);

    expect(result.adjustedTaxableBase).toBe(0);
    expect(result.remainingCarryforward).toBe(6000); // la ley diría 1.000
    expect(result.remainingDetails).toEqual([
      {
        originYear: 2020,
        originalAmount: 5000,
        remainingAmount: 5000,
        expiresYear: 2024,
      },
      {
        originYear: 2025,
        originalAmount: 1000,
        remainingAmount: 1000,
        expiresYear: 2029,
      },
    ]);
  });
});
