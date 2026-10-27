/**
 * Tests de irpf-calculator — Fase A.1 (parametrizado por año en la micro-fase post-A)
 *
 * Verifica la calculadora de IRPF para ganancias patrimoniales (base del
 * ahorro). Desde la Ley 7/2024 la escala depende del EJERCICIO FISCAL:
 *
 *   0 – 6.000 €        → 19%        (igual en ambas escalas)
 *   6.000 – 50.000 €   → 21%        (igual)
 *   50.000 – 200.000 € → 23%        (igual)
 *   200.000 – 300.000 €→ 27%        (igual)
 *   > 300.000 €        → 28% en 2023-2024 · 30% desde 2025 (Ley 7/2024,
 *                        BOE 21-dic-2024, efectos 1-ene-2025; la escala
 *                        agregada suma el tramo estatal del art. 66 LIRPF
 *                        y el autonómico del art. 76)
 *
 * calculateIRPF(gain, year) recibe el año; sin año usa el actual. Los tests
 * por debajo de 300.000 € no pasan año (ambas escalas coinciden); los que
 * cruzan los 300.000 € se testean por pareja: ejercicio 2024 (28%) y 2025 (30%).
 *
 * MODO PROFESOR: los tramos son *progresivos* — cada tipo solo se aplica a
 * la porción de ganancia que cae dentro de su tramo, no a toda la ganancia.
 * Es como una función a trozos: f(x) = Σ min(x - límite_inferior, ancho) × tipo.
 * Por eso pasar una frontera solo encarece el euro que la cruza (tipo
 * marginal), nunca toda la ganancia.
 *
 * REGLA DE ORO de esta suite: todos los valores esperados están derivados a
 * mano desde la ley (comentarios "Derivación:"), nunca copiados del output
 * de la implementación.
 *
 * Impuestos completos por tramo (se reutilizan en varias derivaciones):
 *   Tramo 1 entero:  6.000 × 0,19 =  1.140
 *   Tramo 2 entero: 44.000 × 0,21 =  9.240
 *   Tramo 3 entero: 150.000 × 0,23 = 34.500
 *   Tramo 4 entero: 100.000 × 0,27 = 27.000
 *   (suma hasta 300.000 €: 71.880 — igual en ambas escalas)
 */
import { describe, it, expect } from "vitest";
import {
  calculateIRPF,
  formatIRPFRate,
  getIRPFBracketsForYear,
} from "@/lib/tax/irpf-calculator";

describe("calculateIRPF", () => {
  describe("ganancia dentro del primer tramo (19%)", () => {
    it("3.000 € tributan 570 € (19% plano)", () => {
      // Derivación: 3.000 × 0,19 = 570 · neto = 3.000 − 570 = 2.430
      const r = calculateIRPF(3000);
      expect(r.gain).toBe(3000);
      expect(r.totalTax).toBeCloseTo(570, 2);
      expect(r.netGain).toBeCloseTo(2430, 2);
      // Tipo efectivo = 570/3.000 × 100 = 19% (coincide con el marginal:
      // todo cae en un único tramo)
      expect(r.effectiveRate).toBeCloseTo(19, 6);
    });

    it("el desglose de 3.000 € tiene un solo tramo con to = ganancia", () => {
      const r = calculateIRPF(3000);
      expect(r.brackets).toHaveLength(1);
      expect(r.brackets[0].from).toBe(0);
      // to se reporta como min(límite del tramo, ganancia) = min(6.000, 3.000)
      expect(r.brackets[0].to).toBe(3000);
      expect(r.brackets[0].rate).toBe(0.19);
      expect(r.brackets[0].taxInBracket).toBeCloseTo(570, 2);
      expect(r.brackets[0].accumulatedTax).toBeCloseTo(570, 2);
    });

    it("1 € tributa 0,19 €", () => {
      // Derivación: 1 × 0,19 = 0,19
      const r = calculateIRPF(1);
      expect(r.totalTax).toBeCloseTo(0.19, 6);
      expect(r.netGain).toBeCloseTo(0.81, 6);
    });
  });

  describe("fronteras exactas de tramo", () => {
    it("6.000 € → 1.140 € (agota justo el primer tramo)", () => {
      // Derivación: 6.000 × 0,19 = 1.140
      const r = calculateIRPF(6000);
      expect(r.totalTax).toBeCloseTo(1140, 2);
      expect(r.effectiveRate).toBeCloseTo(19, 6);
      // En la frontera exacta NO debe aparecer un segundo tramo con 0 €
      expect(r.brackets).toHaveLength(1);
      expect(r.brackets[0].to).toBe(6000);
    });

    it("50.000 € → 10.380 €", () => {
      // Derivación: 1.140 + 44.000 × 0,21 = 1.140 + 9.240 = 10.380
      const r = calculateIRPF(50000);
      expect(r.totalTax).toBeCloseTo(10380, 2);
      // Tipo efectivo = 10.380/50.000 × 100 = 20,76%
      expect(r.effectiveRate).toBeCloseTo(20.76, 4);
      expect(r.brackets).toHaveLength(2);
    });

    it("200.000 € → 44.880 €", () => {
      // Derivación: 1.140 + 9.240 + 150.000 × 0,23 = 10.380 + 34.500 = 44.880
      const r = calculateIRPF(200000);
      expect(r.totalTax).toBeCloseTo(44880, 2);
      // Tipo efectivo = 44.880/200.000 × 100 = 22,44%
      expect(r.effectiveRate).toBeCloseTo(22.44, 4);
      expect(r.brackets).toHaveLength(3);
    });

    it("300.000 € → 71.880 €", () => {
      // Derivación: 44.880 + 100.000 × 0,27 = 44.880 + 27.000 = 71.880
      const r = calculateIRPF(300000);
      expect(r.totalTax).toBeCloseTo(71880, 2);
      // Tipo efectivo = 71.880/300.000 × 100 = 23,96%
      expect(r.effectiveRate).toBeCloseTo(23.96, 4);
      expect(r.brackets).toHaveLength(4);
    });
  });

  describe("euro siguiente a cada frontera (tipo marginal)", () => {
    // MODO PROFESOR: el "tipo marginal" es la derivada del impuesto respecto
    // a la ganancia — cuánto cuesta el ÚLTIMO euro. Cruzar una frontera solo
    // grava ese euro extra al tipo nuevo; el resto no se toca.

    it("6.001 € → 1.140,21 € (el euro 6.001 tributa al 21%)", () => {
      // Derivación: 1.140 + 1 × 0,21 = 1.140,21
      const r = calculateIRPF(6001);
      expect(r.totalTax).toBeCloseTo(1140.21, 2);
      expect(r.brackets).toHaveLength(2);
      expect(r.brackets[1].from).toBe(6000);
      expect(r.brackets[1].to).toBe(6001); // min(50.000, 6.001)
      expect(r.brackets[1].rate).toBe(0.21);
      expect(r.brackets[1].taxInBracket).toBeCloseTo(0.21, 6);
      // Marginal = impuesto(6.001) − impuesto(6.000) = 0,21
      expect(r.totalTax - calculateIRPF(6000).totalTax).toBeCloseTo(0.21, 6);
    });

    it("6.000,50 € → 1.140,105 € (céntimos cruzando frontera, sin redondeos intermedios)", () => {
      // Derivación: 1.140 + 0,50 × 0,21 = 1.140,105
      // El cálculo debe conservar las fracciones de céntimo (no redondear
      // tramo a tramo); el redondeo, si procede, es cosa de la capa de UI.
      const r = calculateIRPF(6000.5);
      expect(r.totalTax).toBeCloseTo(1140.105, 6);
      expect(r.netGain).toBeCloseTo(6000.5 - 1140.105, 6);
      expect(r.brackets).toHaveLength(2);
      expect(r.brackets[1].taxInBracket).toBeCloseTo(0.105, 6);
    });

    it("50.001 € → 10.380,23 € (marginal del 23%)", () => {
      // Derivación: 10.380 + 1 × 0,23 = 10.380,23
      const r = calculateIRPF(50001);
      expect(r.totalTax).toBeCloseTo(10380.23, 2);
      expect(r.brackets[2].rate).toBe(0.23);
      expect(r.totalTax - calculateIRPF(50000).totalTax).toBeCloseTo(0.23, 6);
    });

    it("200.001 € → 44.880,27 € (marginal del 27%)", () => {
      // Derivación: 44.880 + 1 × 0,27 = 44.880,27
      const r = calculateIRPF(200001);
      expect(r.totalTax).toBeCloseTo(44880.27, 2);
      expect(r.brackets[3].rate).toBe(0.27);
      expect(r.totalTax - calculateIRPF(200000).totalTax).toBeCloseTo(0.27, 6);
    });

    it("300.001 € en 2024 → 71.880,28 € (marginal del 28%, escala 2023-2024)", () => {
      // Derivación: 71.880 + 1 × 0,28 = 71.880,28
      const r = calculateIRPF(300001, 2024);
      expect(r.totalTax).toBeCloseTo(71880.28, 2);
      expect(r.brackets[4].rate).toBe(0.28);
      expect(r.totalTax - calculateIRPF(300000, 2024).totalTax).toBeCloseTo(0.28, 6);
    });

    it("300.001 € en 2025 → 71.880,30 € (marginal del 30%, Ley 7/2024)", () => {
      // Derivación: 71.880 + 1 × 0,30 = 71.880,30
      const r = calculateIRPF(300001, 2025);
      expect(r.totalTax).toBeCloseTo(71880.3, 2);
      expect(r.brackets[4].rate).toBe(0.3);
      expect(r.totalTax - calculateIRPF(300000, 2025).totalTax).toBeCloseTo(0.3, 6);
    });
  });

  describe("casos multi-tramo derivados a mano", () => {
    it("10.000 € → 1.980 € (dos tramos)", () => {
      // Derivación: 6.000×0,19 + 4.000×0,21 = 1.140 + 840 = 1.980
      const r = calculateIRPF(10000);
      expect(r.totalTax).toBeCloseTo(1980, 2);
      expect(r.netGain).toBeCloseTo(8020, 2);
      // Tipo efectivo = 1.980/10.000 × 100 = 19,8%
      expect(r.effectiveRate).toBeCloseTo(19.8, 4);
    });

    it("60.000 € → 12.680 € (tres tramos)", () => {
      // Derivación: 1.140 + 9.240 + 10.000×0,23 = 1.140 + 9.240 + 2.300 = 12.680
      const r = calculateIRPF(60000);
      expect(r.totalTax).toBeCloseTo(12680, 2);
      expect(r.netGain).toBeCloseTo(47320, 2);
      // Tipo efectivo = 12.680/60.000 × 100 = 21,1333...%
      expect(r.effectiveRate).toBeCloseTo(21.1333, 3);
    });

    it("350.000 € en 2024 → 85.880 € (los cinco tramos, escala 2023-2024)", () => {
      // Derivación: 1.140 + 9.240 + 34.500 + 27.000 + 50.000×0,28
      //   = 71.880 + 14.000 = 85.880
      const r = calculateIRPF(350000, 2024);
      expect(r.totalTax).toBeCloseTo(85880, 2);
      expect(r.netGain).toBeCloseTo(264120, 2);
      // Tipo efectivo = 85.880/350.000 × 100 = 24,5371...%
      expect(r.effectiveRate).toBeCloseTo(24.5371, 3);
      expect(r.brackets).toHaveLength(5);
    });

    it("350.000 € en 2025 → 86.880 € (Ley 7/2024: último tramo al 30%)", () => {
      // Derivación: 71.880 + 50.000×0,30 = 71.880 + 15.000 = 86.880
      //   neto = 350.000 − 86.880 = 263.120
      const r = calculateIRPF(350000, 2025);
      expect(r.totalTax).toBeCloseTo(86880, 2);
      expect(r.netGain).toBeCloseTo(263120, 2);
      // Tipo efectivo = 86.880/350.000 × 100 = 24,8228...%
      expect(r.effectiveRate).toBeCloseTo(24.8229, 3);
      expect(r.brackets).toHaveLength(5);
    });

    it("1.000.000 € en 2024 → 267.880 € (tramo superior abierto, escala 2023-2024)", () => {
      // Derivación: 71.880 + 700.000×0,28 = 71.880 + 196.000 = 267.880
      const r = calculateIRPF(1000000, 2024);
      expect(r.totalTax).toBeCloseTo(267880, 2);
      // El último tramo no tiene techo legal (Infinity), así que
      // to = min(Infinity, ganancia) = la propia ganancia
      expect(r.brackets[4].to).toBe(1000000);
      expect(r.brackets[4].taxInBracket).toBeCloseTo(196000, 2);
    });

    it("1.000.000 € en 2025 → 281.880 € (la subida al 30% son 14.000 € más)", () => {
      // Derivación: 71.880 + 700.000×0,30 = 71.880 + 210.000 = 281.880
      //   Diferencia con 2024: 700.000 × (0,30 − 0,28) = 14.000
      const r = calculateIRPF(1000000, 2025);
      expect(r.totalTax).toBeCloseTo(281880, 2);
      expect(r.brackets[4].taxInBracket).toBeCloseTo(210000, 2);
      expect(r.totalTax - calculateIRPF(1000000, 2024).totalTax).toBeCloseTo(14000, 2);
    });
  });

  describe("pérdidas y ganancia cero", () => {
    // MODO PROFESOR: las pérdidas patrimoniales no tributan — se compensan
    // con ganancias del mismo año o de los 4 siguientes (eso lo gestiona
    // loss-carryforward, no esta calculadora).

    it("ganancia 0 → impuesto 0, sin tramos, neto 0", () => {
      const r = calculateIRPF(0);
      expect(r.totalTax).toBe(0);
      expect(r.effectiveRate).toBe(0);
      expect(r.netGain).toBe(0);
      expect(r.brackets).toEqual([]);
    });

    it("pérdida de −500 € → impuesto 0 y netGain conserva la pérdida", () => {
      const r = calculateIRPF(-500);
      expect(r.gain).toBe(-500);
      expect(r.totalTax).toBe(0);
      expect(r.effectiveRate).toBe(0);
      expect(r.netGain).toBe(-500); // la pérdida pasa intacta
      expect(r.brackets).toEqual([]);
    });
  });

  describe("coherencia interna del resultado", () => {
    it("netGain = gain − totalTax y effectiveRate = totalTax/gain × 100", () => {
      const r = calculateIRPF(60000);
      expect(r.netGain).toBeCloseTo(r.gain - r.totalTax, 6);
      expect(r.effectiveRate).toBeCloseTo((r.totalTax / r.gain) * 100, 6);
    });

    it("brackets[].to se reporta como min(límite del tramo, ganancia)", () => {
      const r = calculateIRPF(10000);
      expect(r.brackets).toHaveLength(2);
      expect(r.brackets[0].to).toBe(6000); // min(6.000, 10.000)
      expect(r.brackets[1].to).toBe(10000); // min(50.000, 10.000)
    });

    it("accumulatedTax acumula tramo a tramo y termina en totalTax (2024)", () => {
      // Derivación (350.000 €, escala 2023-2024): acumulados =
      // 1.140 · 10.380 · 44.880 · 71.880 · 85.880 (sumas parciales de 1.140,
      // 9.240, 34.500, 27.000, 14.000)
      const r = calculateIRPF(350000, 2024);
      const esperados = [1140, 10380, 44880, 71880, 85880];
      r.brackets.forEach((b, i) => {
        expect(b.accumulatedTax).toBeCloseTo(esperados[i], 2);
      });
      expect(r.brackets[r.brackets.length - 1].accumulatedTax).toBeCloseTo(
        r.totalTax,
        6
      );
    });

    it("la suma de taxInBracket coincide con totalTax (2024 y 2025)", () => {
      for (const [year, ultimoTramo] of [
        [2024, 14000],
        [2025, 15000],
      ] as const) {
        const r = calculateIRPF(350000, year);
        const suma = r.brackets.reduce((acc, b) => acc + b.taxInBracket, 0);
        expect(suma).toBeCloseTo(r.totalTax, 6);
        // Y cada porción por tramo coincide con la derivación a mano
        // (solo cambia el último tramo: 50.000×0,28 = 14.000 vs ×0,30 = 15.000)
        const porTramo = [1140, 9240, 34500, 27000, ultimoTramo];
        r.brackets.forEach((b, i) => {
          expect(b.taxInBracket).toBeCloseTo(porTramo[i], 2);
        });
      }
    });
  });

  describe("parametrización por ejercicio fiscal (Ley 7/2024)", () => {
    it("getIRPFBracketsForYear: frontera exacta 2024/2025 en el último tramo", () => {
      const top = (year: number) =>
        getIRPFBracketsForYear(year)[getIRPFBracketsForYear(year).length - 1].rate;
      expect(top(2023)).toBe(0.28);
      expect(top(2024)).toBe(0.28);
      expect(top(2025)).toBe(0.3);
      expect(top(2026)).toBe(0.3);
    });

    it("los tramos por debajo de 300.000 € son idénticos en ambas escalas", () => {
      // Por eso el resto de la suite puede omitir el año sin ambigüedad
      const r2024 = calculateIRPF(300000, 2024);
      const r2025 = calculateIRPF(300000, 2025);
      expect(r2024.totalTax).toBeCloseTo(r2025.totalTax, 6); // 71.880 en ambas
    });

    it("sin año explícito usa el ejercicio actual", () => {
      const r = calculateIRPF(350000);
      const rActual = calculateIRPF(350000, new Date().getFullYear());
      expect(r.totalTax).toBeCloseTo(rActual.totalTax, 6);
    });
  });
});

describe("formatIRPFRate", () => {
  it("formatea 0,19 como '19%'", () => {
    expect(formatIRPFRate(0.19)).toBe("19%");
  });

  it("formatea 0,28 como '28%'", () => {
    expect(formatIRPFRate(0.28)).toBe("28%");
  });

  it("formatea 0 como '0%'", () => {
    expect(formatIRPFRate(0)).toBe("0%");
  });

  it("formatea 1 como '100%'", () => {
    expect(formatIRPFRate(1)).toBe("100%");
  });

  it("redondea a entero: 0,2376 → '24%'", () => {
    // Derivación: 0,2376 × 100 = 23,76 → toFixed(0) redondea a 24
    expect(formatIRPFRate(0.2376)).toBe("24%");
  });
});
