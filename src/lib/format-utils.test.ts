/**
 * Tests de format-utils — Fase C.1
 *
 * Los valores esperados están derivados a mano de las reglas del plan:
 * ≥1M → "1,23 M€" · ≥1000 → "37,4 k€" · <1000 → "850 €" · negativos con signo.
 * Ojo con los espacios: toLocaleString("es-ES") usa NBSP (U+00A0) como
 * separador de miles en algunos runtimes — los tests normalizan a espacio
 * normal para no depender de la versión de ICU.
 */
import { describe, it, expect } from "vitest";
import { formatCompactCurrency, formatPriceTick } from "@/lib/format-utils";

/** Normaliza NBSP/narrow-NBSP a espacio normal (varía entre versiones de ICU) */
function n(s: string): string {
  return s.replace(/[  ]/g, " ");
}

describe("formatCompactCurrency", () => {
  describe("importes < 1000 (sin escala)", () => {
    it("muestra enteros sin decimales", () => {
      expect(n(formatCompactCurrency(850))).toBe("850 €");
      expect(n(formatCompactCurrency(0))).toBe("0 €");
      expect(n(formatCompactCurrency(999))).toBe("999 €");
    });

    it("redondea decimales sueltos", () => {
      expect(n(formatCompactCurrency(850.72))).toBe("851 €");
    });

    it("negativos con signo", () => {
      expect(n(formatCompactCurrency(-850))).toBe("-850 €");
    });
  });

  describe("escala k (≥ 1000)", () => {
    it("usa hasta 1 decimal por debajo de 100k", () => {
      expect(n(formatCompactCurrency(37_446.25))).toBe("37,4 k€");
      expect(n(formatCompactCurrency(1000))).toBe("1 k€");
      expect(n(formatCompactCurrency(1500))).toBe("1,5 k€");
    });

    it("miles limpios sin decimal forzado", () => {
      expect(n(formatCompactCurrency(150_000))).toBe("150 k€");
    });

    it("desde 100k pierde el decimal (~3 cifras significativas)", () => {
      expect(n(formatCompactCurrency(136_300))).toBe("136 k€");
      expect(n(formatCompactCurrency(116_349))).toBe("116 k€");
    });

    it("negativos con signo", () => {
      expect(n(formatCompactCurrency(-37_446.25))).toBe("-37,4 k€");
    });

    it("redondeo hacia arriba dentro de la escala", () => {
      expect(n(formatCompactCurrency(37_960))).toBe("38 k€");
    });
  });

  describe("escala M (≥ 1M)", () => {
    it("usa 2 decimales", () => {
      expect(n(formatCompactCurrency(1_234_567))).toBe("1,23 M€");
      expect(n(formatCompactCurrency(1_000_000))).toBe("1,00 M€");
      expect(n(formatCompactCurrency(12_345_678))).toBe("12,35 M€");
    });

    it("negativos con signo", () => {
      expect(n(formatCompactCurrency(-1_234_567))).toBe("-1,23 M€");
    });
  });

  describe("borde superior de la escala k → nunca '1.000 k€'", () => {
    it("999.400 aún es escala k (sin decimal por ser ≥100k)", () => {
      expect(n(formatCompactCurrency(999_400))).toBe("999 k€");
    });

    it("999.500 redondearía a '1.000 k€' → se promociona a M", () => {
      expect(n(formatCompactCurrency(999_500))).toBe("1,00 M€");
      expect(n(formatCompactCurrency(-999_500))).toBe("-1,00 M€");
    });

    it("mismo borde en la zona con decimal (<100k): 99.940 → '99,9 k€'", () => {
      expect(n(formatCompactCurrency(99_940))).toBe("99,9 k€");
    });
  });

  describe("otras divisas", () => {
    it("usa el símbolo estrecho de la divisa", () => {
      expect(n(formatCompactCurrency(37_446, "USD"))).toBe("37,4 k$");
    });

    it("divisa desconocida no rompe: usa el código tal cual", () => {
      expect(n(formatCompactCurrency(850, "XYZ"))).toContain("850");
    });
  });
});

describe("formatPriceTick (decimales dinámicos según amplitud del eje)", () => {
  it("span ≥ 100 → sin decimales", () => {
    expect(n(formatPriceTick(600, "EUR", 700))).toBe("600 €");
  });

  it("span ≥ 10 → 1 decimal", () => {
    expect(n(formatPriceTick(142.37, "EUR", 40))).toBe("142,4 €");
  });

  it("span < 10 → 2 decimales (el caso del fondo a 142,37 €)", () => {
    expect(n(formatPriceTick(142.37, "EUR", 8))).toBe("142,37 €");
  });

  it("≥1000 con eje ancho delega en el formato compacto", () => {
    expect(n(formatPriceTick(37_446.25, "EUR", 5000))).toBe("37,4 k€");
  });

  it("≥1000 con eje ESTRECHO mantiene el formato completo (review Fase C)", () => {
    // Un NAV a 1.250 € moviéndose ±5 €: en compacto todos los ticks
    // dirían "1,3 k€" — ilegible. (es-ES no agrupa números de 4 dígitos.)
    expect(n(formatPriceTick(1252.5, "EUR", 10))).toBe("1252,5 €");
    expect(n(formatPriceTick(1250, "EUR", 4))).toBe("1250,00 €");
    expect(n(formatPriceTick(12_525, "EUR", 50))).toBe("12.525,0 €");
  });

  it("negativos con signo", () => {
    expect(n(formatPriceTick(-142.37, "EUR", 8))).toBe("-142,37 €");
  });
});
