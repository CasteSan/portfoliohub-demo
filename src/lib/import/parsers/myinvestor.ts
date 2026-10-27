/**
 * Parser de MyInvestor
 *
 * MODO PROFESOR — Formato REAL de extracto MyInvestor (verificado con archivo real):
 *
 * MyInvestor exporta operaciones en .xls, pero el archivo es en realidad
 * una tabla HTML disfrazada de Excel. SheetJS lo lee correctamente, pero
 * los headers salen corruptos porque contienen tags HTML (<th>) mal codificados.
 *
 * Estructura real de columnas (por posición):
 *   [0] Fecha Operación     — formato M/D/YY (SheetJS convierte serial Excel → string US)
 *   [1] Fecha Liquidación    — M/D/YY
 *   [2] Nº Operación        — ID numérico interno (ej: "204371237")
 *   [3] Mercado             — "FONDOS EXTRANJEROS" o "FONDOS ESPAÑOLES"
 *   [4] Tipo Operación      — "SUSCRIPCION", "SUSCR.POR TRASPASO I", "REEMBOLSO", "REEMB.POR TRASPASO I"
 *   [5] ISIN                — ej: "IE0031786696"
 *   [6] Nombre del fondo    — ej: "EMERGING MARKETS STOCK EUR ACC"
 *   [7] Títulos/NOMINAL     — participaciones (decimal con punto, ya convertido por SheetJS)
 *   [8] Divisa              — "EUR" o "USD"
 *   [9] Precio Neto         — precio por participación
 *   [10] Importe neto       — importe total de la operación
 *
 * Peculiaridades:
 * - Fila 0: headers (corruptos por HTML), fila 1: sub-headers → datos desde fila 2
 * - Decimal: PUNTO (SheetJS ya convierte los números del Excel)
 * - Fecha: M/D/YY (SheetJS convierte los seriales de fecha a formato US corto)
 * - No hay columna "Comisión" (las comisiones van incluidas en el precio neto)
 * - Los traspasos (SUSCR.POR TRASPASO / REEMB.POR TRASPASO) se mapean como
 *   TRANSFER_IN/TRANSFER_OUT — no generan hecho imponible en España
 */

import type { ParsedRow } from "../types";
import { parseLocalNumber, parseLocalDate } from "./generic";

/**
 * Mapeo de tipos de operación de MyInvestor a nuestros tipos.
 * Usamos startsWith para manejar textos truncados como "SUSCR.POR TRASPASO I"
 * que podría ser "SUSCR.POR TRASPASO INTERNO" o "SUSCR.POR TRASPASO INTEREMPRESAS".
 */
type TxType = "BUY" | "SELL" | "DIVIDEND" | "TRANSFER_IN" | "TRANSFER_OUT";

const TYPE_PREFIXES: Array<{ prefix: string; type: TxType }> = [
  // Traspasos ANTES de suscripción/reembolso genérico (prefix más específico primero)
  { prefix: "suscr.por traspaso", type: "TRANSFER_IN" },
  { prefix: "reemb.por traspaso", type: "TRANSFER_OUT" },
  // Operaciones regulares
  { prefix: "suscripcion", type: "BUY" },
  { prefix: "suscripcion rv", type: "BUY" },
  { prefix: "compra", type: "BUY" },
  { prefix: "reembolso", type: "SELL" },
  { prefix: "venta", type: "SELL" },
  { prefix: "dividendo", type: "DIVIDEND" },
  { prefix: "cobro de dividendo", type: "DIVIDEND" },
];

/**
 * Mapea un tipo de operación de MyInvestor al tipo interno.
 *
 * IMPORTANTE: Los traspasos entre fondos (SUSCR.POR TRASPASO / REEMB.POR TRASPASO)
 * se mapean como TRANSFER_IN / TRANSFER_OUT. Fiscalmente en España NO generan
 * hecho imponible — el coste de adquisición se arrastra al nuevo fondo.
 */
function mapOperationType(rawType: string): TxType | null {
  const lower = rawType.trim().toLowerCase();
  for (const { prefix, type } of TYPE_PREFIXES) {
    if (lower.startsWith(prefix)) return type;
  }
  return null;
}

/**
 * Detecta si una fila es una fila de datos válida de MyInvestor.
 * Comprueba que tiene un ISIN (col 5) que parece un código válido.
 */
function isDataRow(row: string[]): boolean {
  if (!row || row.length < 8) return false;
  const isin = String(row[5] || "").trim();
  // Un ISIN tiene EXACTAMENTE 12 caracteres: 2 letras país + 10 alfanuméricos
  // (9 del código + 1 dígito de control)
  return /^[A-Z]{2}[A-Z0-9]{10}$/.test(isin);
}

/**
 * Parsea un archivo de MyInvestor (ya convertido a arrays por SheetJS).
 *
 * Como los headers son poco fiables (HTML corruptos), usamos detección
 * posicional basada en el formato real verificado con un archivo de producción.
 *
 * @param rawData - Filas del Excel (incluye header corruptos + sub-header)
 * @returns ParsedRow[] normalizadas
 */
export function parseMyInvestor(rawData: string[][]): ParsedRow[] {
  if (rawData.length < 3) return []; // headers + subheader + al menos 1 fila

  const rows: ParsedRow[] = [];

  // Columna labels para el objeto 'raw' (usamos nombres descriptivos)
  const COL_NAMES = [
    "Fecha Operación", "Fecha Liquidación", "Nº Operación",
    "Mercado", "Operación", "ISIN", "Valor",
    "Títulos", "Divisa", "Precio Neto", "Importe Neto",
  ];

  for (let i = 0; i < rawData.length; i++) {
    const row = rawData[i];

    // Solo procesar filas que parecen datos (tienen ISIN válido)
    if (!isDataRow(row)) continue;

    // Extraer valores por posición
    const rawDate = String(row[0] || "").trim();
    const operationType = String(row[4] || "").trim();
    const isin = String(row[5] || "").trim();
    const fundName = String(row[6] || "").trim();
    const rawShares = String(row[7] || "0").trim();
    const currency = String(row[8] || "EUR").trim();
    const rawPrice = String(row[9] || "0").trim();
    const rawAmount = String(row[10] || "0").trim();

    // Parsear fecha — SheetJS usa formato M/D/YY para fechas Excel
    const dateStr =
      parseLocalDate(rawDate, "M/D/YY") ||
      parseLocalDate(rawDate, "MM/DD/YYYY") ||
      parseLocalDate(rawDate, "DD/MM/YYYY");
    if (!dateStr) continue;

    // Mapear tipo de operación
    const type = mapOperationType(operationType);
    if (!type) continue;

    // Parsear números (SheetJS ya convierte a decimal con punto)
    // (el importe de la operación solo se usa como texto en notes → rawAmount)
    const shares = parseLocalNumber(rawShares, ".");
    const price = parseLocalNumber(rawPrice, ".");

    // Number.isFinite descarta NaN de celdas no numéricas (NaN <= 0 es false)
    if (!Number.isFinite(shares) || shares <= 0) continue;
    if (!Number.isFinite(price)) continue;

    // Construir objeto raw para debugging
    const raw: Record<string, string> = {};
    COL_NAMES.forEach((name, idx) => {
      raw[name] = String(row[idx] || "");
    });

    rows.push({
      rowIndex: i + 1,  // 1-indexed para el usuario
      date: dateStr,
      identifier: isin,
      identifierType: "isin",
      name: fundName || undefined,
      type,
      shares: Math.abs(shares),
      pricePerShare: Math.abs(price),
      fees: 0,  // MyInvestor no separa comisiones, van incluidas en precio neto
      currency: currency || "EUR",
      // Para ventas/reembolsos, guardar el importe neto como referencia
      notes: `${operationType} | Importe: ${rawAmount} ${currency}`,
      raw,
    });
  }

  return rows;
}
