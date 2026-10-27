/**
 * Calculadora de IRPF para ganancias patrimoniales (España)
 *
 * Las ganancias patrimoniales (venta de acciones, fondos, ETFs)
 * tributan en la base del ahorro con tramos progresivos.
 *
 * MODO PROFESOR — los tramos dependen del AÑO FISCAL:
 * La escala del ahorro no es fija: la Ley 7/2024 subió el tramo más alto
 * (>300.000€) del 28% al 30% con efectos desde el ejercicio 2025.
 * Por eso calculateIRPF recibe el año: la misma ganancia tributa distinto
 * según el ejercicio en que se realiza.
 *
 * Tramos 2023-2024:                    Tramos 2025+ (Ley 7/2024):
 * - Hasta 6.000€: 19%                  - Hasta 6.000€: 19%
 * - 6.000 a 50.000€: 21%               - 6.000 a 50.000€: 21%
 * - 50.000 a 200.000€: 23%             - 50.000 a 200.000€: 23%
 * - 200.000 a 300.000€: 27%            - 200.000 a 300.000€: 27%
 * - Más de 300.000€: 28%               - Más de 300.000€: 30%
 *
 * NOTA: para ejercicios ≤2022 la escala era distinta (sin tramo de
 * 300.000€); si algún día se calculan años tan antiguos, habría que
 * añadir sus escalas aquí.
 */

export type IRPFBracket = {
  from: number;
  to: number;
  rate: number;
  taxInBracket: number;
  accumulatedTax: number;
};

export type IRPFResult = {
  gain: number; // Ganancia antes de impuestos
  totalTax: number; // Impuesto total
  effectiveRate: number; // Tipo efectivo (%)
  netGain: number; // Ganancia neta después de impuestos
  brackets: IRPFBracket[]; // Desglose por tramos
};

type Bracket = { from: number; to: number; rate: number };

// Tramos IRPF para base del ahorro, ejercicios 2023-2024
const IRPF_BRACKETS_2024: Bracket[] = [
  { from: 0, to: 6000, rate: 0.19 },
  { from: 6000, to: 50000, rate: 0.21 },
  { from: 50000, to: 200000, rate: 0.23 },
  { from: 200000, to: 300000, rate: 0.27 },
  { from: 300000, to: Infinity, rate: 0.28 },
];

// Tramos IRPF para base del ahorro, ejercicios 2025+ (Ley 7/2024)
const IRPF_BRACKETS_2025: Bracket[] = [
  { from: 0, to: 6000, rate: 0.19 },
  { from: 6000, to: 50000, rate: 0.21 },
  { from: 50000, to: 200000, rate: 0.23 },
  { from: 200000, to: 300000, rate: 0.27 },
  { from: 300000, to: Infinity, rate: 0.30 },
];

/**
 * Devuelve la escala del ahorro vigente para un ejercicio fiscal.
 */
export function getIRPFBracketsForYear(year: number): Bracket[] {
  return year >= 2025 ? IRPF_BRACKETS_2025 : IRPF_BRACKETS_2024;
}

/**
 * Calcula el IRPF para una ganancia patrimonial.
 *
 * NOTA: Solo aplica a ganancias. Las pérdidas no pagan impuestos,
 * y pueden compensar ganancias del mismo año o los 4 años siguientes.
 *
 * @param gain - Ganancia patrimonial (positiva)
 * @param year - Ejercicio fiscal (default: año actual). Determina la escala:
 *               desde 2025 el tramo >300.000€ tributa al 30% (Ley 7/2024).
 * @returns Desglose del cálculo de IRPF
 */
export function calculateIRPF(
  gain: number,
  year: number = new Date().getFullYear()
): IRPFResult {
  // Las pérdidas no pagan impuestos
  if (gain <= 0) {
    return {
      gain,
      totalTax: 0,
      effectiveRate: 0,
      netGain: gain,
      brackets: [],
    };
  }

  const brackets: IRPFBracket[] = [];
  let remainingGain = gain;
  let totalTax = 0;
  let accumulatedTax = 0;

  for (const bracket of getIRPFBracketsForYear(year)) {
    if (remainingGain <= 0) break;

    const bracketSize = bracket.to - bracket.from;
    const amountInBracket = Math.min(remainingGain, bracketSize);
    const taxInBracket = amountInBracket * bracket.rate;

    accumulatedTax += taxInBracket;
    totalTax += taxInBracket;
    remainingGain -= amountInBracket;

    brackets.push({
      from: bracket.from,
      to: Math.min(bracket.to, gain),
      rate: bracket.rate,
      taxInBracket,
      accumulatedTax,
    });
  }

  const effectiveRate = gain > 0 ? (totalTax / gain) * 100 : 0;
  const netGain = gain - totalTax;

  return {
    gain,
    totalTax,
    effectiveRate,
    netGain,
    brackets,
  };
}

/**
 * Formatea el tipo de IRPF como porcentaje.
 */
export function formatIRPFRate(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`;
}
