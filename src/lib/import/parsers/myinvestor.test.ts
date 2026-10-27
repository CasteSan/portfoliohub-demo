/**
 * Tests del parser de MyInvestor — Fase A.1
 *
 * MODO PROFESOR — Cómo se construye el fixture:
 * MyInvestor exporta un .xls que en realidad es HTML; SheetJS lo convierte
 * a arrays, pero la fila 0 (headers) sale corrupta con tags <th>. El parser
 * por eso NO confía en los headers: detecta filas de datos comprobando que
 * la columna 5 contiene un ISIN sintácticamente válido.
 *
 * Los ISINs del fixture son sintácticamente válidos pero FICTICIOS
 * (12 caracteres exactos, pasan /^[A-Z]{2}[A-Z0-9]{10}$/), y los importes
 * cuadran a mano: importe = títulos × precio.
 */

import { describe, it, expect } from "vitest";
import { parseMyInvestor } from "@/lib/import/parsers/myinvestor";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture: estructura real verificada (header corrupto + subheader + datos)
// Columnas: [0] F.Operación [1] F.Liquidación [2] Nº Op [3] Mercado
//           [4] Tipo Op [5] ISIN [6] Nombre [7] Títulos [8] Divisa
//           [9] Precio Neto [10] Importe Neto
// ─────────────────────────────────────────────────────────────────────────────

const HEADER_CORRUPTO = [
  "<th>Fecha Operación</th>", "<th>Fecha Liquidación</th>", "<th>Nº Operación</th>",
  "<th>Mercado</th>", "<th>Operación</th>", "<th>ISIN</th>", "<th>Valor</th>",
  "<th>Títulos</th>", "<th>Divisa</th>", "<th>Precio</th>", "<th>Importe</th>",
];

// Sub-header: col 5 = "ISIN" (4 letras) NO pasa el regex de ISIN → se salta
const SUBHEADER = [
  "Fecha Operación", "Fecha Liquidación", "Nº Operación",
  "Mercado", "Operación", "ISIN", "Valor",
  "Títulos/NOMINAL", "Divisa", "Precio Neto", "Importe neto",
];

describe("parseMyInvestor", () => {
  it("salta headers corruptos y subheader; solo procesa filas con ISIN válido", () => {
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      // Derivación importe: 10.5 × 95.2 = 999.6
      ["1/15/24", "1/17/24", "204000001", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000001", "FONDO GLOBAL ACCIONES EUR ACC", "10.5", "EUR", "95.2", "999.6"],
    ];

    const rows = parseMyInvestor(rawData);

    expect(rows).toHaveLength(1);
    expect(rows[0].identifier).toBe("IE0000000001");
    expect(rows[0].identifierType).toBe("isin");
    expect(rows[0].name).toBe("FONDO GLOBAL ACCIONES EUR ACC");
    // rowIndex 1-indexed: la fila de datos está en el índice 2 del array → fila 3
    expect(rows[0].rowIndex).toBe(3);
  });

  it("mapea los 4 tipos de operación: SUSCRIPCION/REEMBOLSO/traspasos", () => {
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      // 10.5 × 95.2 = 999.6
      ["1/15/24", "1/17/24", "204000001", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000001", "FONDO GLOBAL", "10.5", "EUR", "95.2", "999.6"],
      // 4 × 100.25 = 401
      ["2/20/24", "2/22/24", "204000002", "FONDOS EXTRANJEROS", "REEMBOLSO",
        "IE0000000001", "FONDO GLOBAL", "4", "EUR", "100.25", "401"],
      // 2.345 × 200 = 469 — traspaso de entrada: NO es hecho imponible en España
      ["3/5/24", "3/7/24", "204000003", "FONDOS EXTRANJEROS", "SUSCR.POR TRASPASO I",
        "LU0000000002", "FONDO INDEXADO RV USA", "2.345", "EUR", "200", "469"],
      // 30 × 15.63 = 468.9 — traspaso de salida
      ["3/5/24", "3/7/24", "204000004", "FONDOS ESPAÑOLES", "REEMB.POR TRASPASO I",
        "ES0000000003", "FONDO MONETARIO EUR", "30", "EUR", "15.63", "468.9"],
    ];

    const rows = parseMyInvestor(rawData);

    expect(rows).toHaveLength(4);
    expect(rows[0].type).toBe("BUY");
    expect(rows[1].type).toBe("SELL");
    // Los prefijos de traspaso tienen prioridad sobre suscripción/reembolso:
    // "SUSCR.POR TRASPASO I" → TRANSFER_IN, no BUY
    expect(rows[2].type).toBe("TRANSFER_IN");
    expect(rows[3].type).toBe("TRANSFER_OUT");
  });

  it("mapea los prefijos restantes: DIVIDENDO, COBRO DE DIVIDENDO, COMPRA y VENTA", () => {
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      // "dividendo" es prefijo directo → DIVIDEND
      ["1/15/24", "1/17/24", "204000020", "FONDOS EXTRANJEROS", "DIVIDENDO",
        "IE0000000001", "FONDO REPARTO", "1", "EUR", "0.5", "0.5"],
      // "cobro de dividendo" NO empieza por "dividendo": necesita su propia
      // entrada en TYPE_PREFIXES → DIVIDEND
      ["1/16/24", "1/18/24", "204000021", "FONDOS EXTRANJEROS", "COBRO DE DIVIDENDO",
        "IE0000000001", "FONDO REPARTO", "1", "EUR", "0.75", "0.75"],
      // "compra" → BUY (alias de suscripción para otros productos)
      ["1/17/24", "1/19/24", "204000022", "FONDOS EXTRANJEROS", "COMPRA",
        "IE0000000001", "FONDO", "2", "EUR", "50", "100"],
      // "venta" → SELL
      ["1/18/24", "1/20/24", "204000023", "FONDOS EXTRANJEROS", "VENTA",
        "IE0000000001", "FONDO", "2", "EUR", "55", "110"],
    ];

    const rows = parseMyInvestor(rawData);

    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.type)).toEqual(["DIVIDEND", "DIVIDEND", "BUY", "SELL"]);
  });

  it("convierte fechas M/D/YY a ISO (pivote de siglo en 50)", () => {
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      // "1/15/24" = 15 de enero de 2024 (24 < 50 → siglo XXI)
      ["1/15/24", "1/17/24", "204000001", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000001", "FONDO", "1", "EUR", "100", "100"],
      // "12/1/25" = 1 de diciembre de 2025
      ["12/1/25", "12/3/25", "204000002", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000001", "FONDO", "1", "EUR", "100", "100"],
    ];

    const rows = parseMyInvestor(rawData);

    expect(rows[0].date).toBe("2024-01-15");
    expect(rows[1].date).toBe("2025-12-01");
  });

  it("cae al formato DD/MM/YYYY si M/D/YY y MM/DD/YYYY no encajan", () => {
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      // "16/04/2025": como M/D/YY el mes sería 16 (inválido) → fallback
      // a DD/MM/YYYY → 16 de abril de 2025
      ["16/04/2025", "18/04/2025", "204000001", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000001", "FONDO", "1", "EUR", "100", "100"],
      // "12/31/2024": M/D/YY daría año 1900+2024 (fuera de rango) → fallback
      // a MM/DD/YYYY → 31 de diciembre de 2024
      ["12/31/2024", "12/31/2024", "204000002", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000001", "FONDO", "1", "EUR", "100", "100"],
    ];

    const rows = parseMyInvestor(rawData);

    expect(rows).toHaveLength(2);
    expect(rows[0].date).toBe("2025-04-16");
    expect(rows[1].date).toBe("2024-12-31");
  });

  it("salta filas con fecha inválida en todos los formatos", () => {
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      ["99/99/99", "99/99/99", "204000001", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000001", "FONDO", "1", "EUR", "100", "100"],
    ];

    expect(parseMyInvestor(rawData)).toHaveLength(0);
  });

  it("salta operaciones no reconocidas (ej: comisiones de custodia)", () => {
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      ["1/15/24", "1/17/24", "204000001", "FONDOS EXTRANJEROS", "COMISION CUSTODIA",
        "IE0000000001", "FONDO", "1", "EUR", "100", "100"],
    ];

    expect(parseMyInvestor(rawData)).toHaveLength(0);
  });

  it("salta filas con shares <= 0", () => {
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      ["1/15/24", "1/17/24", "204000001", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000001", "FONDO", "0", "EUR", "100", "0"],
      ["1/16/24", "1/18/24", "204000002", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000001", "FONDO", "-2", "EUR", "100", "-200"],
    ];

    expect(parseMyInvestor(rawData)).toHaveLength(0);
  });

  it("fees siempre 0 (MyInvestor incluye comisiones en el precio neto)", () => {
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      ["1/15/24", "1/17/24", "204000001", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000001", "FONDO", "10.5", "EUR", "95.2", "999.6"],
    ];

    const rows = parseMyInvestor(rawData);

    expect(rows[0].fees).toBe(0);
  });

  it("parsea números con punto decimal (SheetJS ya convierte el Excel)", () => {
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      // Derivación: 10.5 participaciones a 95.2 €/part
      ["1/15/24", "1/17/24", "204000001", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000001", "FONDO", "10.5", "EUR", "95.2", "999.6"],
    ];

    const rows = parseMyInvestor(rawData);

    expect(rows[0].shares).toBeCloseTo(10.5, 10);
    expect(rows[0].pricePerShare).toBeCloseTo(95.2, 10);
  });

  it("divisa por defecto EUR cuando la columna está vacía", () => {
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      ["5/10/24", "5/12/24", "204000006", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000001", "FONDO", "1", "", "100", "100"],
    ];

    const rows = parseMyInvestor(rawData);

    expect(rows[0].currency).toBe("EUR");
  });

  it("divisa de solo espacios → EUR (segundo fallback, tras el trim)", () => {
    // " " es truthy antes del trim, así que sobrevive al primer `|| "EUR"`,
    // pero tras trim() queda "" y entra el fallback final `currency || "EUR"`
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      ["5/11/24", "5/13/24", "204000013", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000001", "FONDO", "1", " ", "100", "100"],
    ];

    const rows = parseMyInvestor(rawData);

    expect(rows[0].currency).toBe("EUR");
  });

  it("fila con fecha y operación vacías se salta sin romper", () => {
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      // ISIN válido (es fila de datos) pero fecha [0], operación [4] y títulos [7] vacíos
      ["", "1/17/24", "204000012", "FONDOS EXTRANJEROS", "",
        "IE0000000001", "FONDO", "", "EUR", "100", "100"],
    ];

    expect(parseMyInvestor(rawData)).toHaveLength(0);
  });

  it("respeta la divisa cuando viene informada (USD)", () => {
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      ["5/10/24", "5/12/24", "204000007", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000001", "FONDO USD", "1", "USD", "100", "100"],
    ];

    const rows = parseMyInvestor(rawData);

    expect(rows[0].currency).toBe("USD");
  });

  it("notes contiene la operación original y el importe", () => {
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      ["2/20/24", "2/22/24", "204000002", "FONDOS EXTRANJEROS", "REEMBOLSO",
        "IE0000000001", "FONDO", "4", "EUR", "100.25", "401"],
    ];

    const rows = parseMyInvestor(rawData);

    // Formato documentado: "<operación> | Importe: <importe> <divisa>"
    expect(rows[0].notes).toBe("REEMBOLSO | Importe: 401 EUR");
  });

  it("raw conserva las columnas originales con nombres descriptivos", () => {
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      ["1/15/24", "1/17/24", "204000001", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000001", "FONDO GLOBAL", "10.5", "EUR", "95.2", "999.6"],
    ];

    const rows = parseMyInvestor(rawData);

    expect(rows[0].raw["ISIN"]).toBe("IE0000000001");
    expect(rows[0].raw["Operación"]).toBe("SUSCRIPCION");
    expect(rows[0].raw["Títulos"]).toBe("10.5");
    expect(rows[0].raw["Importe Neto"]).toBe("999.6");
  });

  it("fila corta sin precio ni importe (9 columnas) → valores por defecto 0", () => {
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      // Faltan las columnas Precio Neto [9] e Importe Neto [10]
      ["1/15/24", "1/17/24", "204000010", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000001", "FONDO", "3", "EUR"],
    ];

    const rows = parseMyInvestor(rawData);

    expect(rows).toHaveLength(1);
    expect(rows[0].shares).toBe(3);
    // Precio ausente → "0" → 0
    expect(rows[0].pricePerShare).toBe(0);
    // Importe ausente → "0" en las notas
    expect(rows[0].notes).toBe("SUSCRIPCION | Importe: 0 EUR");
  });

  it("nombre de fondo vacío → name undefined", () => {
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      ["1/15/24", "1/17/24", "204000011", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000001", "", "2", "EUR", "100", "200"],
    ];

    const rows = parseMyInvestor(rawData);

    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBeUndefined();
  });

  it("devuelve [] con menos de 3 filas (headers + subheader + datos)", () => {
    expect(parseMyInvestor([])).toHaveLength(0);
    expect(parseMyInvestor([HEADER_CORRUPTO, SUBHEADER])).toHaveLength(0);
  });

  it("frontera de longitud del ISIN: solo 12 caracteres exactos pasan (fix post-fase-A)", () => {
    // El regex es /^[A-Z]{2}[A-Z0-9]{10}$/ → longitud total EXACTA de 12,
    // como un ISIN real (2 letras de país + 9 alfanuméricos + 1 dígito de
    // control). Antes el {9,10} dejaba pasar identificadores de 11 caracteres.
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      // 12 caracteres (2 + 10): ISIN válido → la fila SE procesa
      ["1/15/24", "1/17/24", "204000029", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000017", "FONDO 12 CHARS", "1", "EUR", "100", "100"],
      // 11 caracteres (2 + 9): NO pasa (antes sí — comportamiento laxo corregido)
      ["1/15/24", "1/17/24", "204000030", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE000000001", "FONDO 11 CHARS", "1", "EUR", "100", "100"],
      // 10 caracteres (2 + 8): NO pasa
      ["1/16/24", "1/18/24", "204000031", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE00000001", "FONDO 10 CHARS", "1", "EUR", "100", "100"],
      // 13 caracteres (2 + 11): NO pasa
      ["1/17/24", "1/19/24", "204000032", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE00000000012", "FONDO 13 CHARS", "1", "EUR", "100", "100"],
    ];

    const rows = parseMyInvestor(rawData);

    expect(rows).toHaveLength(1);
    expect(rows[0].identifier).toBe("IE0000000017");
  });

  it("celdas no numéricas → fila rechazada, nunca NaN (fix post-fase-A)", () => {
    // `NaN <= 0` es false, así que sin Number.isFinite una celda ilegible
    // colaba la fila con shares/price = NaN.
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      // Títulos ilegibles → fuera
      ["1/15/24", "1/17/24", "204000040", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000017", "FONDO A", "abc", "EUR", "100", "100"],
      // Precio ilegible → fuera
      ["1/16/24", "1/18/24", "204000041", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000017", "FONDO B", "2", "EUR", "n/d", "200"],
      // Fila sana de control → entra
      ["1/17/24", "1/19/24", "204000042", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000017", "FONDO C", "3", "EUR", "100", "300"],
    ];

    const rows = parseMyInvestor(rawData);

    expect(rows).toHaveLength(1);
    expect(rows[0].shares).toBe(3);
    expect(rows[0].pricePerShare).toBe(100);
  });

  it("salta filas demasiado cortas o sin ISIN", () => {
    const rawData = [
      HEADER_CORRUPTO,
      SUBHEADER,
      // Fila con menos de 8 columnas → no es fila de datos
      ["1/15/24", "1/17/24", "204000001"],
      // Fila larga pero con celda de ISIN vacía → tampoco es fila de datos
      ["1/15/24", "1/17/24", "204000003", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "", "FONDO", "1", "EUR", "100", "100"],
      ["1/15/24", "1/17/24", "204000002", "FONDOS EXTRANJEROS", "SUSCRIPCION",
        "IE0000000001", "FONDO", "1", "EUR", "100", "100"],
    ];

    const rows = parseMyInvestor(rawData);

    expect(rows).toHaveLength(1);
    expect(rows[0].rowIndex).toBe(5);
  });
});
