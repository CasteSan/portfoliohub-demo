/**
 * Parser genérico de CSV
 *
 * Usa un ColumnMapping proporcionado por el usuario para convertir
 * filas CSV arbitrarias a ParsedRow[]. Incluye helpers para parsear
 * números y fechas con diferentes formatos locales.
 *
 * MODO PROFESOR — Separadores decimales:
 * En España se usa la coma: 1.234,56 (mil doscientos treinta y cuatro con 56)
 * En EEUU/UK se usa el punto: 1,234.56
 * Al parsear un CSV, hay que saber qué formato usa para no confundir
 * "1,234" (mil doscientos treinta y cuatro) con "1.234" (uno punto dos tres cuatro).
 */

import type {
  ParsedRow,
  ColumnMapping,
  TypeMapping,
  DecimalSeparator,
  DateFormat,
} from "../types";

/**
 * Parsea un número con separador decimal configurable.
 *
 * Ejemplos:
 * - parseLocalNumber("1.234,56", ",") → 1234.56
 * - parseLocalNumber("1,234.56", ".") → 1234.56
 * - parseLocalNumber("25.50", ".")    → 25.5
 * - parseLocalNumber("25,50", ",")    → 25.5
 */
export function parseLocalNumber(
  value: string,
  decimalSeparator: DecimalSeparator = "."
): number {
  if (!value || value.trim() === "") return 0;

  const cleaned = value.trim();

  if (decimalSeparator === ",") {
    // Formato español: "1.234,56" → quitar puntos de miles, cambiar coma por punto
    return parseFloat(cleaned.replace(/\./g, "").replace(",", "."));
  }

  // Formato inglés: "1,234.56" → quitar comas de miles
  return parseFloat(cleaned.replace(/,/g, ""));
}

/**
 * Parsea una fecha en diferentes formatos y devuelve ISO (YYYY-MM-DD).
 *
 * Soporta:
 * - DD/MM/YYYY (o DD-MM-YYYY): formato español habitual
 * - MM/DD/YYYY (o MM-DD-YYYY): formato americano
 * - M/D/YY: formato corto americano (SheetJS convierte Excel dates a esto)
 * - YYYY-MM-DD: formato ISO
 * - YYYYMMDD: formato compacto (Interactive Brokers)
 */
export function parseLocalDate(
  value: string,
  format: DateFormat = "DD/MM/YYYY"
): string | null {
  if (!value || value.trim() === "") return null;

  const cleaned = value.trim();
  let day: number, month: number, year: number;

  try {
    switch (format) {
      case "DD/MM/YYYY": {
        const parts = cleaned.split(/[/\-\.]/);
        if (parts.length !== 3) return null;
        day = parseInt(parts[0], 10);
        month = parseInt(parts[1], 10);
        year = parseInt(parts[2], 10);
        break;
      }
      case "MM/DD/YYYY": {
        const parts = cleaned.split(/[/\-\.]/);
        if (parts.length !== 3) return null;
        month = parseInt(parts[0], 10);
        day = parseInt(parts[1], 10);
        year = parseInt(parts[2], 10);
        break;
      }
      case "YYYY-MM-DD": {
        const parts = cleaned.split(/[/\-\.]/);
        if (parts.length !== 3) return null;
        year = parseInt(parts[0], 10);
        month = parseInt(parts[1], 10);
        day = parseInt(parts[2], 10);
        break;
      }
      case "YYYYMMDD": {
        if (cleaned.length < 8) return null;
        year = parseInt(cleaned.substring(0, 4), 10);
        month = parseInt(cleaned.substring(4, 6), 10);
        day = parseInt(cleaned.substring(6, 8), 10);
        break;
      }
      case "M/D/YY": {
        // Formato corto americano: "4/16/25", "12/1/24"
        // SheetJS convierte fechas de Excel a este formato por defecto
        const parts = cleaned.split("/");
        if (parts.length !== 3) return null;
        month = parseInt(parts[0], 10);
        day = parseInt(parts[1], 10);
        const shortYear = parseInt(parts[2], 10);
        // Año de 2 dígitos: 00-49 → 2000-2049, 50-99 → 1950-1999
        year = shortYear < 50 ? 2000 + shortYear : 1900 + shortYear;
        break;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }

  // Validar rangos básicos
  if (
    isNaN(day) || isNaN(month) || isNaN(year) ||
    day < 1 || day > 31 ||
    month < 1 || month > 12 ||
    year < 1900 || year > 2100
  ) {
    return null;
  }

  // Formatear a ISO
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * Intenta auto-detectar el separador decimal de un conjunto de valores.
 * Busca patrones como "1.234,56" (coma) vs "1,234.56" (punto).
 */
export function detectDecimalSeparator(
  values: string[]
): DecimalSeparator {
  let commaAsDecimal = 0;
  let dotAsDecimal = 0;

  for (const v of values) {
    const trimmed = v.trim();
    // Patrón "N,NN" al final → coma es decimal
    if (/\d,\d{1,2}$/.test(trimmed) && !/\d,\d{3}/.test(trimmed)) {
      commaAsDecimal++;
    }
    // Patrón "N.NN" al final → punto es decimal
    if (/\d\.\d{1,2}$/.test(trimmed) && !/\d\.\d{3}/.test(trimmed)) {
      dotAsDecimal++;
    }
  }

  return commaAsDecimal > dotAsDecimal ? "," : ".";
}

/**
 * Parser genérico de CSV.
 *
 * Toma filas ya parseadas (array de arrays) y las convierte a ParsedRow[]
 * usando un ColumnMapping que indica qué columna del CSV corresponde
 * a qué campo de la transacción.
 *
 * @param rawData - Filas del CSV (primera fila = headers)
 * @param mapping - Qué columna CSV corresponde a qué campo
 * @param typeMapping - Mapeo de tipos de operación (ej: "Compra" → "BUY")
 * @param options - Formato de fecha y separador decimal
 */
export function parseGenericCSV(
  rawData: string[][],
  mapping: ColumnMapping,
  typeMapping: TypeMapping,
  options: {
    dateFormat?: DateFormat;
    decimalSeparator?: DecimalSeparator;
  } = {}
): ParsedRow[] {
  if (rawData.length < 2) return []; // Necesita al menos header + 1 fila

  const { dateFormat = "DD/MM/YYYY", decimalSeparator = "." } = options;

  // Construir mapa de nombre de columna → índice
  const headers = rawData[0].map((h) => h.trim());
  const colIndex = (name: string): number =>
    headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());

  const dateIdx = colIndex(mapping.date);
  const identIdx = colIndex(mapping.identifier);
  const typeIdx = colIndex(mapping.type);
  const sharesIdx = colIndex(mapping.shares);
  const priceIdx = colIndex(mapping.pricePerShare);
  const feesIdx = mapping.fees ? colIndex(mapping.fees) : -1;
  const currencyIdx = mapping.currency ? colIndex(mapping.currency) : -1;
  const notesIdx = mapping.notes ? colIndex(mapping.notes) : -1;

  // Validar que las columnas requeridas existen
  if (dateIdx === -1 || identIdx === -1 || typeIdx === -1 || sharesIdx === -1 || priceIdx === -1) {
    return [];
  }

  const rows: ParsedRow[] = [];

  for (let i = 1; i < rawData.length; i++) {
    const row = rawData[i];
    if (!row || row.every((cell) => !cell || cell.trim() === "")) continue; // Saltar filas vacías

    // Construir objeto raw con headers como claves
    const raw: Record<string, string> = {};
    headers.forEach((h, idx) => {
      raw[h] = row[idx] || "";
    });

    // Parsear fecha
    const dateStr = parseLocalDate(row[dateIdx] || "", dateFormat);
    if (!dateStr) continue; // Saltar filas con fecha inválida

    // Parsear tipo de operación
    const rawType = (row[typeIdx] || "").trim();
    const mappedType = typeMapping[rawType] || typeMapping[rawType.toLowerCase()];
    if (!mappedType || mappedType === "SKIP") continue;

    // Parsear valores numéricos
    const shares = parseLocalNumber(row[sharesIdx] || "0", decimalSeparator);
    const pricePerShare = parseLocalNumber(row[priceIdx] || "0", decimalSeparator);
    const rawFees = feesIdx >= 0 ? parseLocalNumber(row[feesIdx] || "0", decimalSeparator) : 0;
    // Comisión ilegible → 0 (campo opcional); shares/precio ilegibles → fila fuera
    const fees = Number.isFinite(rawFees) ? rawFees : 0;

    // OJO: NaN se cuela por las comparaciones de signo (NaN <= 0 es false),
    // así que una celda no numérica ("abc") pasaría sin Number.isFinite
    if (!Number.isFinite(shares) || shares <= 0) continue;
    if (!Number.isFinite(pricePerShare) || pricePerShare < 0) continue;

    rows.push({
      rowIndex: i + 1, // 1-indexed para el usuario
      date: dateStr,
      identifier: (row[identIdx] || "").trim(),
      identifierType: mapping.identifierType,
      type: mappedType,
      shares: Math.abs(shares),
      pricePerShare: Math.abs(pricePerShare),
      fees: Math.abs(fees),
      currency: currencyIdx >= 0 ? (row[currencyIdx] || "").trim() : undefined,
      notes: notesIdx >= 0 ? (row[notesIdx] || "").trim() : undefined,
      raw,
    });
  }

  return rows;
}
