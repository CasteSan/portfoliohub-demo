/**
 * Tests de risk-utils — Fase D.3
 *
 * Expectativas derivadas a mano (1,65 × σ y tabla de cubos SRRI del
 * CESR/10-673); ningún valor sale de ejecutar la implementación.
 */
import { describe, it, expect } from "vitest";
import {
  riskPhraseValue,
  riskPhraseExceedsMax,
  volatilityToSRRIBucket,
  RISK_PHRASE_MAX,
} from "@/lib/risk-utils";

describe("riskPhraseValue — caída estimada en un año malo (1,65σ)", () => {
  it("σ = 12% → 20 (ejemplo del plan: 1,65 × 12 = 19,8 → 20)", () => {
    expect(riskPhraseValue(0.12)).toBe(20);
  });

  it("σ = 7% → 12 (1,65 × 7 = 11,55 → 12)", () => {
    expect(riskPhraseValue(0.07)).toBe(12);
  });

  it("σ = 8,01% (cartera test medida) → 13 (1,65 × 8,01 = 13,2165)", () => {
    expect(riskPhraseValue(0.0801)).toBe(13);
  });

  it("redondeo hacia abajo también: σ = 2% → 3 (1,65 × 2 = 3,3)", () => {
    expect(riskPhraseValue(0.02)).toBe(3);
  });

  it("σ = 0 → 0 (serie plana: sin base para estimar caída)", () => {
    expect(riskPhraseValue(0)).toBe(0);
  });

  it("valores imposibles (negativos, NaN, Infinity) → 0, nunca una cifra inventada", () => {
    expect(riskPhraseValue(-0.1)).toBe(0);
    expect(riskPhraseValue(NaN)).toBe(0);
    expect(riskPhraseValue(Infinity)).toBe(0);
  });

  // Tope del 100 % (backlog 2026-10-11: Amper mostraba "133 %" con σ ≈ 80 %).
  // Sin apalancamiento no se pierde más de lo que se tiene; la normal no lo sabe.
  it("σ = 60% → 99 (1,65 × 60 = 99: justo por debajo del tope)", () => {
    expect(riskPhraseValue(0.6)).toBe(99);
  });

  it("σ = 61% → 100 (1,65 × 61 = 100,65 → 101, acotado al tope)", () => {
    expect(riskPhraseValue(0.61)).toBe(100);
  });

  it("σ = 80% (el caso de Amper) → 100, no 132", () => {
    expect(riskPhraseValue(0.8)).toBe(100);
    expect(riskPhraseValue(0.8)).toBe(RISK_PHRASE_MAX);
  });

  it("volatilidades absurdas (σ = 500%) se quedan en el tope", () => {
    expect(riskPhraseValue(5)).toBe(100);
  });

  // Banda de redondeo: 1,65σ ∈ [99,5; 100] ya redondea a 100 sin superar el tope.
  it("σ = 60,5% → 100 por redondeo (1,65 × 60,5 = 99,825)", () => {
    expect(riskPhraseValue(0.605)).toBe(100);
  });

  it("σ = 60,61% → 100 (1,65 × 60,61 = 100,0065, ya por encima del tope)", () => {
    expect(riskPhraseValue(0.6061)).toBe(100);
  });
});

describe("riskPhraseExceedsMax — ¿la estimación SIN redondear supera el tope?", () => {
  it("σ = 60% → false (1,65 × 60 = 99)", () => {
    expect(riskPhraseExceedsMax(0.6)).toBe(false);
  });

  it("σ = 60,5% → false aunque la cifra mostrada sea 100 (99,825 solo redondea)", () => {
    expect(riskPhraseExceedsMax(0.605)).toBe(false);
  });

  it("σ = 60,61% → true (100,0065 > 100)", () => {
    expect(riskPhraseExceedsMax(0.6061)).toBe(true);
  });

  it("σ = 80% (el caso de Amper) → true (132 > 100)", () => {
    expect(riskPhraseExceedsMax(0.8)).toBe(true);
  });

  it("valores imposibles (0, negativos, NaN, Infinity) → false, como riskPhraseValue", () => {
    expect(riskPhraseExceedsMax(0)).toBe(false);
    expect(riskPhraseExceedsMax(-0.1)).toBe(false);
    expect(riskPhraseExceedsMax(NaN)).toBe(false);
    expect(riskPhraseExceedsMax(Infinity)).toBe(false);
  });
});

describe("volatilityToSRRIBucket — cubos oficiales del SRRI", () => {
  it("valores centrales de cada cubo", () => {
    expect(volatilityToSRRIBucket(0.002)).toBe(1); // 0,2%
    expect(volatilityToSRRIBucket(0.01)).toBe(2); // 1%
    expect(volatilityToSRRIBucket(0.03)).toBe(3); // 3%
    expect(volatilityToSRRIBucket(0.08)).toBe(4); // 8%
    expect(volatilityToSRRIBucket(0.12)).toBe(5); // 12%
    expect(volatilityToSRRIBucket(0.2)).toBe(6); // 20%
    expect(volatilityToSRRIBucket(0.35)).toBe(7); // 35%
  });

  it("fronteras EXACTAS: pertenecen al nivel inferior (tabla 'hasta el X%')", () => {
    expect(volatilityToSRRIBucket(0.005)).toBe(1);
    expect(volatilityToSRRIBucket(0.02)).toBe(2);
    expect(volatilityToSRRIBucket(0.05)).toBe(3);
    expect(volatilityToSRRIBucket(0.1)).toBe(4);
    expect(volatilityToSRRIBucket(0.15)).toBe(5);
    expect(volatilityToSRRIBucket(0.25)).toBe(6);
  });

  it("justo por encima de cada frontera: nivel siguiente", () => {
    expect(volatilityToSRRIBucket(0.0051)).toBe(2);
    expect(volatilityToSRRIBucket(0.0201)).toBe(3);
    expect(volatilityToSRRIBucket(0.0501)).toBe(4);
    expect(volatilityToSRRIBucket(0.1001)).toBe(5);
    expect(volatilityToSRRIBucket(0.1501)).toBe(6);
    expect(volatilityToSRRIBucket(0.2501)).toBe(7);
  });

  it("bordes degenerados: 0 → 1; negativos/NaN → 1 (nunca asustar con dato inventado)", () => {
    expect(volatilityToSRRIBucket(0)).toBe(1);
    expect(volatilityToSRRIBucket(-1)).toBe(1);
    expect(volatilityToSRRIBucket(NaN)).toBe(1);
  });

  it("la cartera test medida (σ 8,01%) cae en el nivel 4", () => {
    expect(volatilityToSRRIBucket(0.0801)).toBe(4);
  });
});
