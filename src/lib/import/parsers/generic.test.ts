/**
 * Tests del parser genérico de CSV — Fase A.1
 *
 * MODO PROFESOR — Qué se testea aquí:
 * El parser genérico es la base de todo el pipeline de importación:
 * - parseLocalNumber: números en formato español ("1.234,56") y anglosajón ("1,234.56")
 * - parseLocalDate: 5 formatos de fecha → ISO (YYYY-MM-DD)
 * - detectDecimalSeparator: heurística de mayoría coma vs punto
 * - parseGenericCSV: mapeo de columnas por nombre + typeMapping + filtrado de filas inválidas
 *
 * Todos los valores esperados están derivados a mano desde el formato
 * documentado, NUNCA copiados de la salida de la implementación.
 */

import { describe, it, expect } from "vitest";
import {
  parseLocalNumber,
  parseLocalDate,
  detectDecimalSeparator,
  parseGenericCSV,
} from "@/lib/import/parsers/generic";
import type { ColumnMapping, TypeMapping, DateFormat } from "@/lib/import/types";

// ─────────────────────────────────────────────────────────────────────────────
// parseLocalNumber
// ─────────────────────────────────────────────────────────────────────────────

describe("parseLocalNumber", () => {
  it("parsea formato español: punto de miles + coma decimal", () => {
    // Derivación: "1.234,56" = mil doscientos treinta y cuatro con 56 → 1234.56
    expect(parseLocalNumber("1.234,56", ",")).toBeCloseTo(1234.56, 10);
  });

  it("parsea formato español sin miles", () => {
    // Derivación: "25,50" = veinticinco con cincuenta → 25.5
    expect(parseLocalNumber("25,50", ",")).toBeCloseTo(25.5, 10);
  });

  it("parsea formato anglosajón: coma de miles + punto decimal", () => {
    // Derivación: "1,234.56" = mil doscientos treinta y cuatro con 56 → 1234.56
    expect(parseLocalNumber("1,234.56", ".")).toBeCloseTo(1234.56, 10);
  });

  it("parsea formato anglosajón sin miles", () => {
    // Derivación: "25.50" → 25.5
    expect(parseLocalNumber("25.50", ".")).toBeCloseTo(25.5, 10);
  });

  it("usa punto como separador por defecto", () => {
    // Sin segundo argumento, el separador decimal es "."
    expect(parseLocalNumber("100.25")).toBeCloseTo(100.25, 10);
  });

  it("cadena vacía devuelve 0", () => {
    expect(parseLocalNumber("", ",")).toBe(0);
    expect(parseLocalNumber("", ".")).toBe(0);
  });

  it("cadena de solo espacios devuelve 0", () => {
    expect(parseLocalNumber("   ", ",")).toBe(0);
  });

  it("conserva el signo negativo", () => {
    // Derivación: "-1.500,75" en formato español → -1500.75
    expect(parseLocalNumber("-1.500,75", ",")).toBeCloseTo(-1500.75, 10);
  });

  it("ignora espacios alrededor del número", () => {
    // " 42,5 " → trim → "42,5" → 42.5
    expect(parseLocalNumber(" 42,5 ", ",")).toBeCloseTo(42.5, 10);
  });

  it("varios separadores de miles en formato español", () => {
    // Derivación: "1.234.567,89" → 1234567.89
    expect(parseLocalNumber("1.234.567,89", ",")).toBeCloseTo(1234567.89, 6);
  });

  it("valor no numérico → NaN (no 0): parseFloat('abc') = NaN", () => {
    // Derivación: "abc" no empieza por dígito → parseFloat devuelve NaN.
    // Por contrato, la función devuelve NaN y son los PARSERS quienes filtran
    // con Number.isFinite (fix post-fase-A) — así "celda ilegible" (NaN) se
    // distingue de "celda vacía" (0).
    expect(parseLocalNumber("abc", ".")).toBeNaN();
    expect(parseLocalNumber("abc", ",")).toBeNaN();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseLocalDate
// ─────────────────────────────────────────────────────────────────────────────

describe("parseLocalDate", () => {
  it("DD/MM/YYYY (formato español) → ISO", () => {
    // 31 de diciembre de 2024 → "2024-12-31"
    expect(parseLocalDate("31/12/2024", "DD/MM/YYYY")).toBe("2024-12-31");
  });

  it("DD-MM-YYYY con guiones también funciona (split por /, - o .)", () => {
    // 5 de enero de 2023 → padding a 2 dígitos → "2023-01-05"
    expect(parseLocalDate("5-1-2023", "DD/MM/YYYY")).toBe("2023-01-05");
  });

  it("MM/DD/YYYY (formato americano) → ISO", () => {
    // 12/31/2024 = mes 12, día 31 → "2024-12-31"
    expect(parseLocalDate("12/31/2024", "MM/DD/YYYY")).toBe("2024-12-31");
  });

  it("YYYY-MM-DD (ISO) se conserva normalizado", () => {
    expect(parseLocalDate("2024-03-07", "YYYY-MM-DD")).toBe("2024-03-07");
  });

  it("YYYYMMDD (formato compacto de IB) → ISO", () => {
    // "20240315" → año 2024, mes 03, día 15 → "2024-03-15"
    expect(parseLocalDate("20240315", "YYYYMMDD")).toBe("2024-03-15");
  });

  it("M/D/YY: año < 50 va al siglo XXI", () => {
    // Pivote de siglo: 00-49 → 2000-2049. "4/16/25" → 2025-04-16
    expect(parseLocalDate("4/16/25", "M/D/YY")).toBe("2025-04-16");
  });

  it("M/D/YY: año 49 es el último del siglo XXI", () => {
    // 49 < 50 → 2049
    expect(parseLocalDate("12/1/49", "M/D/YY")).toBe("2049-12-01");
  });

  it("M/D/YY: año >= 50 va al siglo XX", () => {
    // 50-99 → 1950-1999. "6/30/99" → 1999-06-30
    expect(parseLocalDate("6/30/99", "M/D/YY")).toBe("1999-06-30");
  });

  it("M/D/YY: año 50 exacto es el primer año del siglo XX (frontera del pivote)", () => {
    // Derivación: la condición es shortYear < 50 → siglo XXI.
    // 50 < 50 es false → 1900 + 50 = 1950. Es el valor frontera exacto:
    // 49 → 2049 (ya cubierto) y 50 → 1950 quedan a un solo entero de distancia.
    expect(parseLocalDate("6/30/50", "M/D/YY")).toBe("1950-06-30");
  });

  it("usa DD/MM/YYYY por defecto", () => {
    // Sin formato explícito: "01/02/2024" = 1 de febrero → "2024-02-01"
    expect(parseLocalDate("01/02/2024")).toBe("2024-02-01");
  });

  it("mes 13 → null", () => {
    // No existe el mes 13: en DD/MM/YYYY la parte central es el mes
    expect(parseLocalDate("15/13/2024", "DD/MM/YYYY")).toBeNull();
  });

  it("día 32 → null", () => {
    expect(parseLocalDate("32/01/2024", "DD/MM/YYYY")).toBeNull();
  });

  it("formato roto (texto sin estructura de fecha) → null", () => {
    expect(parseLocalDate("no-es-fecha", "DD/MM/YYYY")).toBeNull();
  });

  it("número incorrecto de partes → null", () => {
    // Solo 2 componentes en un formato que exige 3
    expect(parseLocalDate("01/2024", "DD/MM/YYYY")).toBeNull();
    expect(parseLocalDate("2024-05", "YYYY-MM-DD")).toBeNull();
  });

  it("YYYYMMDD con menos de 8 caracteres → null", () => {
    expect(parseLocalDate("2024", "YYYYMMDD")).toBeNull();
  });

  it("cadena vacía → null", () => {
    expect(parseLocalDate("", "DD/MM/YYYY")).toBeNull();
    expect(parseLocalDate("   ", "YYYY-MM-DD")).toBeNull();
  });

  it("año fuera de rango (1900-2100) → null", () => {
    expect(parseLocalDate("01/01/1899", "DD/MM/YYYY")).toBeNull();
    expect(parseLocalDate("01/01/2101", "DD/MM/YYYY")).toBeNull();
  });

  it("formato desconocido → null (rama default del switch)", () => {
    // Forzamos un formato inválido con cast para cubrir la rama default
    expect(parseLocalDate("01/01/2024", "XX/XX" as DateFormat)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectDecimalSeparator
// ─────────────────────────────────────────────────────────────────────────────

describe("detectDecimalSeparator", () => {
  it("mayoría de valores con coma decimal → ','", () => {
    // "1.234,56", "10,50" y "2,00" terminan en coma + 2 dígitos → 3 votos coma, 0 punto
    expect(detectDecimalSeparator(["1.234,56", "10,50", "2,00"])).toBe(",");
  });

  it("mayoría de valores con punto decimal → '.'", () => {
    // "1,234.56", "10.50" y "2.00" terminan en punto + 2 dígitos → 3 votos punto
    expect(detectDecimalSeparator(["1,234.56", "10.50", "2.00"])).toBe(".");
  });

  it("sin patrón decimal claro (enteros) → '.' por defecto", () => {
    // 0 votos coma vs 0 votos punto → como no hay mayoría de coma, gana "."
    expect(detectDecimalSeparator(["100", "200", "300"])).toBe(".");
  });

  it("empate → '.' (la coma solo gana con mayoría estricta)", () => {
    // 1 voto coma ("10,50") vs 1 voto punto ("10.50") → "."
    expect(detectDecimalSeparator(["10,50", "10.50"])).toBe(".");
  });

  it("array vacío → '.'", () => {
    expect(detectDecimalSeparator([])).toBe(".");
  });

  it("separadores de miles solos ('1.234', '1,234') NO votan como decimal", () => {
    // Derivación: 3 dígitos tras el separador al final de cadena no matchean
    // /\d[.,]\d{1,2}$/ → 0 votos coma, 0 votos punto → default "."
    expect(detectDecimalSeparator(["1.234", "1,234"])).toBe(".");
  });

  it("regex de exclusión: separador repetido como miles Y decimal anula el voto coma", () => {
    // Derivación: "1,234,56" SÍ matchea /\d,\d{1,2}$/ (",56" final), pero
    // /\d,\d{3}/ matchea "1,234" → voto anulado. Sin la exclusión sería
    // coma=2 > punto=1 → ","; con ella: coma=0 < punto=1 → "."
    expect(detectDecimalSeparator(["1,234,56", "1,234,56", "10.50"])).toBe(".");
  });

  it("regex de exclusión: separador repetido anula el voto punto (caso simétrico)", () => {
    // Derivación: "1.234.56" matchea /\d\.\d{1,2}$/ pero /\d\.\d{3}/ matchea
    // "1.234" → 0 votos punto. Sin exclusión: punto=2 > coma=1 → ".";
    // con ella: coma=1 > punto=0 → ","
    expect(detectDecimalSeparator(["1.234.56", "1.234.56", "10,50"])).toBe(",");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseGenericCSV
// ─────────────────────────────────────────────────────────────────────────────

describe("parseGenericCSV", () => {
  // Fixture base: CSV español con cabeceras descriptivas.
  // ISINs sintácticamente válidos pero ficticios.
  const HEADERS = [
    "Fecha",
    "ISIN",
    "Tipo",
    "Participaciones",
    "Precio",
    "Comision",
    "Divisa",
    "Notas",
  ];

  const mapping: ColumnMapping = {
    // Mayúsculas distintas a las del header → prueba el matching case-insensitive
    date: "fecha",
    identifier: "isin",
    identifierType: "isin",
    type: "TIPO",
    shares: "Participaciones",
    pricePerShare: "precio",
    fees: "comision",
    currency: "divisa",
    notes: "notas",
  };

  const typeMapping: TypeMapping = {
    Compra: "BUY",
    Venta: "SELL",
    Traspaso: "SKIP",
    // Clave en minúsculas para probar el fallback rawType.toLowerCase()
    dividendo: "DIVIDEND",
  };

  const options = { dateFormat: "DD/MM/YYYY" as const, decimalSeparator: "," as const };

  it("parsea una fila válida con todos los campos mapeados", () => {
    const rawData = [
      HEADERS,
      ["15/01/2024", "ES0000000001", "Compra", "10", "100,50", "1,50", "EUR", "aporte mensual"],
    ];

    const rows = parseGenericCSV(rawData, mapping, typeMapping, options);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    // rowIndex es 1-indexed para el usuario: header = fila 1, primera fila de datos = fila 2
    expect(row.rowIndex).toBe(2);
    expect(row.date).toBe("2024-01-15");
    expect(row.identifier).toBe("ES0000000001");
    expect(row.identifierType).toBe("isin");
    expect(row.type).toBe("BUY");
    expect(row.shares).toBe(10);
    // Derivación: "100,50" en formato español → 100.5
    expect(row.pricePerShare).toBeCloseTo(100.5, 10);
    // Derivación: "1,50" → 1.5
    expect(row.fees).toBeCloseTo(1.5, 10);
    expect(row.currency).toBe("EUR");
    expect(row.notes).toBe("aporte mensual");
  });

  it("raw conserva las columnas originales con sus headers como claves", () => {
    const rawData = [
      HEADERS,
      ["15/01/2024", "ES0000000001", "Compra", "10", "100,50", "1,50", "EUR", "nota"],
    ];

    const rows = parseGenericCSV(rawData, mapping, typeMapping, options);

    // El objeto raw guarda los valores SIN parsear, clave = header original
    expect(rows[0].raw).toEqual({
      Fecha: "15/01/2024",
      ISIN: "ES0000000001",
      Tipo: "Compra",
      Participaciones: "10",
      Precio: "100,50",
      Comision: "1,50",
      Divisa: "EUR",
      Notas: "nota",
    });
  });

  it("typeMapping con SKIP descarta la fila", () => {
    const rawData = [
      HEADERS,
      ["15/01/2024", "ES0000000001", "Traspaso", "10", "100,00", "0", "EUR", ""],
      ["16/01/2024", "ES0000000001", "Venta", "5", "110,00", "0", "EUR", ""],
    ];

    const rows = parseGenericCSV(rawData, mapping, typeMapping, options);

    // Solo sobrevive la Venta
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("SELL");
  });

  it("tipo no mapeado descarta la fila", () => {
    const rawData = [
      HEADERS,
      ["15/01/2024", "ES0000000001", "Comisión custodia", "1", "5,00", "0", "EUR", ""],
    ];

    expect(parseGenericCSV(rawData, mapping, typeMapping, options)).toHaveLength(0);
  });

  it("el tipo cae al fallback en minúsculas si la clave exacta no existe", () => {
    // "Dividendo" no es clave del mapping, pero "dividendo" sí
    const rawData = [
      HEADERS,
      ["15/01/2024", "ES0000000001", "Dividendo", "1", "0,50", "0", "EUR", ""],
    ];

    const rows = parseGenericCSV(rawData, mapping, typeMapping, options);

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("DIVIDEND");
  });

  it("salta filas completamente vacías", () => {
    const rawData = [
      HEADERS,
      ["", "", "", "", "", "", "", ""],
      ["15/01/2024", "ES0000000001", "Compra", "10", "100,00", "0", "EUR", ""],
    ];

    const rows = parseGenericCSV(rawData, mapping, typeMapping, options);

    expect(rows).toHaveLength(1);
    // La fila vacía era la fila 2 del archivo; la válida es la 3
    expect(rows[0].rowIndex).toBe(3);
  });

  it("salta filas con fecha inválida", () => {
    const rawData = [
      HEADERS,
      ["32/01/2024", "ES0000000001", "Compra", "10", "100,00", "0", "EUR", ""],
      ["15/13/2024", "ES0000000001", "Compra", "10", "100,00", "0", "EUR", ""],
    ];

    expect(parseGenericCSV(rawData, mapping, typeMapping, options)).toHaveLength(0);
  });

  it("salta filas con shares <= 0", () => {
    const rawData = [
      HEADERS,
      ["15/01/2024", "ES0000000001", "Compra", "0", "100,00", "0", "EUR", ""],
      ["16/01/2024", "ES0000000001", "Compra", "-5", "100,00", "0", "EUR", ""],
    ];

    expect(parseGenericCSV(rawData, mapping, typeMapping, options)).toHaveLength(0);
  });

  it("salta filas con precio negativo", () => {
    const rawData = [
      HEADERS,
      ["15/01/2024", "ES0000000001", "Compra", "10", "-100,00", "0", "EUR", ""],
    ];

    expect(parseGenericCSV(rawData, mapping, typeMapping, options)).toHaveLength(0);
  });

  it("shares no numérico ('abc') → fila rechazada (fix NaN post-fase-A)", () => {
    // parseLocalNumber("abc") → NaN, y `NaN <= 0` es false: el filtro de signo
    // no lo atrapaba. Desde el fix, Number.isFinite descarta la fila entera —
    // nunca debe importarse una transacción con shares=NaN.
    const rawData = [
      HEADERS,
      ["15/01/2024", "ES0000000001", "Compra", "abc", "100,00", "0", "EUR", ""],
    ];

    expect(parseGenericCSV(rawData, mapping, typeMapping, options)).toHaveLength(0);
  });

  it("precio no numérico ('abc') → fila rechazada (fix NaN post-fase-A)", () => {
    // Misma raíz que shares: `NaN < 0` es false. Number.isFinite la descarta.
    const rawData = [
      HEADERS,
      ["15/01/2024", "ES0000000001", "Compra", "10", "abc", "0", "EUR", ""],
    ];

    expect(parseGenericCSV(rawData, mapping, typeMapping, options)).toHaveLength(0);
  });

  it("comisión no numérica ('abc') → fila importada con fees=0 (campo opcional)", () => {
    // La comisión es opcional: una celda ilegible no debe tirar la fila entera,
    // pero tampoco propagar NaN — se normaliza a 0.
    const rawData = [
      HEADERS,
      ["15/01/2024", "ES0000000001", "Compra", "10", "100,00", "abc", "EUR", ""],
    ];

    const rows = parseGenericCSV(rawData, mapping, typeMapping, options);

    expect(rows).toHaveLength(1);
    expect(rows[0].shares).toBe(10);
    expect(rows[0].fees).toBe(0);
  });

  it("comisiones negativas se normalizan con valor absoluto", () => {
    // Algunos brokers exportan comisiones con signo negativo
    const rawData = [
      HEADERS,
      ["15/01/2024", "ES0000000001", "Compra", "10", "100,00", "-2,25", "EUR", ""],
    ];

    const rows = parseGenericCSV(rawData, mapping, typeMapping, options);

    // Derivación: |-2,25| = 2.25
    expect(rows[0].fees).toBeCloseTo(2.25, 10);
  });

  it("fees, currency y notes son opcionales: sin mapeo → fees 0 y campos undefined", () => {
    const minimalMapping: ColumnMapping = {
      date: "fecha",
      identifier: "isin",
      identifierType: "isin",
      type: "tipo",
      shares: "participaciones",
      pricePerShare: "precio",
      // sin fees, currency ni notes
    };
    const rawData = [
      HEADERS,
      ["15/01/2024", "ES0000000001", "Compra", "10", "100,00", "9,99", "EUR", "ignorada"],
    ];

    const rows = parseGenericCSV(rawData, minimalMapping, typeMapping, options);

    expect(rows).toHaveLength(1);
    expect(rows[0].fees).toBe(0);
    expect(rows[0].currency).toBeUndefined();
    expect(rows[0].notes).toBeUndefined();
  });

  it("devuelve [] si falta alguna columna requerida", () => {
    const badMapping: ColumnMapping = {
      ...mapping,
      date: "columna-inexistente",
    };
    const rawData = [
      HEADERS,
      ["15/01/2024", "ES0000000001", "Compra", "10", "100,00", "0", "EUR", ""],
    ];

    expect(parseGenericCSV(rawData, badMapping, typeMapping, options)).toHaveLength(0);
  });

  it("devuelve [] si solo hay header (sin filas de datos)", () => {
    expect(parseGenericCSV([HEADERS], mapping, typeMapping, options)).toHaveLength(0);
    expect(parseGenericCSV([], mapping, typeMapping, options)).toHaveLength(0);
  });

  it("fila más corta que los headers → celdas faltantes tratadas como vacías", () => {
    // Solo 5 celdas frente a 8 headers: comisión, divisa y notas ausentes
    const rawData = [
      HEADERS,
      ["15/01/2024", "ES0000000001", "Compra", "10", "100,50"],
    ];

    const rows = parseGenericCSV(rawData, mapping, typeMapping, options);

    expect(rows).toHaveLength(1);
    // Celda de comisión ausente → se parsea "0" → 0
    expect(rows[0].fees).toBe(0);
    // Celda de divisa ausente pero la columna SÍ está mapeada → "" (no undefined)
    expect(rows[0].currency).toBe("");
    expect(rows[0].notes).toBe("");
    // raw rellena las celdas ausentes con cadena vacía
    expect(rows[0].raw["Divisa"]).toBe("");
    expect(rows[0].raw["Notas"]).toBe("");
  });

  it("usa formatos por defecto (DD/MM/YYYY y punto decimal) si no se pasan options", () => {
    const rawData = [
      HEADERS,
      ["15/01/2024", "ES0000000001", "Compra", "2.5", "100.25", "0", "EUR", ""],
    ];

    const rows = parseGenericCSV(rawData, mapping, typeMapping);

    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe("2024-01-15");
    // Con separador "." por defecto: "2.5" → 2.5 participaciones
    expect(rows[0].shares).toBeCloseTo(2.5, 10);
    expect(rows[0].pricePerShare).toBeCloseTo(100.25, 10);
  });
});
