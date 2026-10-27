/**
 * Parser de Interactive Brokers — Flex Query CSV
 *
 * MODO PROFESOR — Formato de Flex Query de IB:
 * Interactive Brokers permite exportar un "Flex Query" en CSV.
 * Es un formato complejo con MÚLTIPLES SECCIONES en el mismo archivo.
 *
 * Estructura típica:
 *   Statement,Header,Field Name,...
 *   Statement,Data,...
 *   Trades,Header,DataDiscriminator,Asset Category,Currency,...
 *   Trades,Data,Order,Stocks,USD,...
 *   Trades,Data,Order,Stocks,USD,...
 *   Dividends,Header,...
 *   Dividends,Data,...
 *
 * Cada sección empieza con un header que indica sus columnas.
 * Hay que buscar la sección "Trades" y parsear solo esas filas.
 *
 * Peculiaridades:
 * - Quantity negativa = SELL, positiva = BUY
 * - Separador decimal: punto (formato inglés)
 * - Fecha: YYYYMMDD o YYYY-MM-DD
 * - Identificador: Symbol (ticker, ej: AAPL, SAN)
 * - Los dividendos están en una sección separada
 */

import type { ParsedRow } from "../types";
import { parseLocalNumber, parseLocalDate } from "./generic";

/**
 * Detecta el índice de una columna por nombre (case insensitive)
 */
function findCol(headers: string[], ...names: string[]): number {
  for (const name of names) {
    const idx = headers.findIndex(
      (h) => h.trim().toLowerCase() === name.toLowerCase()
    );
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * Parsea un Flex Query CSV de Interactive Brokers.
 *
 * El rawData ya viene parseado por PapaParse (array de arrays).
 * Esta función busca la sección "Trades" y opcionalmente "Dividends".
 *
 * @param rawData - Filas del CSV
 * @returns ParsedRow[] normalizadas
 */
export function parseInteractiveBrokers(rawData: string[][]): ParsedRow[] {
  const rows: ParsedRow[] = [];

  // ─── Detectar formato ────────────────────────────────────────────────
  // Formato 1: Multi-sección (Trades,Header,... / Trades,Data,...)
  // Formato 2: CSV simple con una sola sección de trades

  const isMultiSection = rawData.some(
    (row) =>
      row[0]?.trim().toLowerCase() === "trades" &&
      row[1]?.trim().toLowerCase() === "header"
  );

  if (isMultiSection) {
    // ─── Parsear sección Trades ─────────────────────────────────────────
    parseTradeSectionMulti(rawData, rows);
    // ─── Parsear sección Dividends ──────────────────────────────────────
    parseDividendSectionMulti(rawData, rows);
  } else {
    // ─── Formato CSV simple (una sola tabla) ────────────────────────────
    parseSimpleFormat(rawData, rows);
  }

  return rows;
}

/**
 * Parsea la sección "Trades" de un Flex Query multi-sección
 */
function parseTradeSectionMulti(rawData: string[][], rows: ParsedRow[]) {
  // Encontrar el header de Trades
  let tradesHeaderIdx = -1;
  for (let i = 0; i < rawData.length; i++) {
    const row = rawData[i];
    if (
      row[0]?.trim().toLowerCase() === "trades" &&
      row[1]?.trim().toLowerCase() === "header"
    ) {
      tradesHeaderIdx = i;
      break;
    }
  }

  if (tradesHeaderIdx === -1) return;

  // Las columnas están a partir del índice 2 (después de "Trades" y "Header")
  const headers = rawData[tradesHeaderIdx].slice(2).map((h) => (h || "").trim());

  const symbolIdx = findCol(headers, "symbol", "ticker");
  const dateIdx = findCol(headers, "date/time", "tradedate", "date", "datetime");
  const qtyIdx = findCol(headers, "quantity", "qty");
  const priceIdx = findCol(headers, "tradeprice", "price", "t. price");
  const feesIdx = findCol(headers, "ibcommission", "commission", "comm/fee", "comm");
  const currIdx = findCol(headers, "currencyprimary", "currency", "cur.");
  const assetIdx = findCol(headers, "assetcategory", "asset category");

  if (symbolIdx === -1 || qtyIdx === -1) return;

  // Recorrer filas de datos de Trades
  for (let i = tradesHeaderIdx + 1; i < rawData.length; i++) {
    const row = rawData[i];

    // Parar al llegar a otra sección
    if (row[0]?.trim().toLowerCase() !== "trades") break;
    // Solo filas de datos (no subtotales ni totales)
    if (row[1]?.trim().toLowerCase() !== "data") continue;

    const dataRow = row.slice(2); // Quitar "Trades" y "Data"

    // Filtrar: solo stocks, ETFs (no forex, opciones, etc.)
    if (assetIdx >= 0) {
      const asset = (dataRow[assetIdx] || "").trim().toLowerCase();
      if (asset === "forex" || asset === "cash" || asset === "option" || asset === "options") continue;
    }

    const raw: Record<string, string> = {};
    headers.forEach((h, idx) => {
      raw[h] = String(dataRow[idx] || "");
    });

    // Parsear fecha (IB usa YYYYMMDD o YYYY-MM-DD, a veces con hora)
    const rawDate = String(dataRow[dateIdx] || "").split(",")[0].split(" ")[0].trim();
    const dateStr =
      parseLocalDate(rawDate, "YYYYMMDD") ||
      parseLocalDate(rawDate, "YYYY-MM-DD");
    if (!dateStr) continue;

    // Parsear cantidad (negativa = SELL)
    // Number.isFinite descarta NaN de celdas no numéricas (NaN === 0 es false)
    const qty = parseLocalNumber(String(dataRow[qtyIdx] || "0"), ".");
    if (!Number.isFinite(qty) || qty === 0) continue;

    const type = qty > 0 ? "BUY" : "SELL";

    const price = priceIdx >= 0
      ? parseLocalNumber(String(dataRow[priceIdx] || "0"), ".")
      : 0;
    if (!Number.isFinite(price)) continue;
    const rawFees = feesIdx >= 0
      ? parseLocalNumber(String(dataRow[feesIdx] || "0"), ".")
      : 0;
    const fees = Number.isFinite(rawFees) ? rawFees : 0; // comisión ilegible → 0

    rows.push({
      rowIndex: i + 1,
      date: dateStr,
      identifier: String(dataRow[symbolIdx] || "").trim(),
      identifierType: "ticker",
      type,
      shares: Math.abs(qty),
      pricePerShare: Math.abs(price),
      fees: Math.abs(fees),
      currency: currIdx >= 0 ? String(dataRow[currIdx] || "").trim() || undefined : undefined,
      raw,
    });
  }
}

/**
 * Parsea la sección "Dividends" de un Flex Query multi-sección
 */
function parseDividendSectionMulti(rawData: string[][], rows: ParsedRow[]) {
  // Encontrar el header de Dividends
  let divHeaderIdx = -1;
  for (let i = 0; i < rawData.length; i++) {
    const row = rawData[i];
    if (
      row[0]?.trim().toLowerCase() === "dividends" &&
      row[1]?.trim().toLowerCase() === "header"
    ) {
      divHeaderIdx = i;
      break;
    }
  }

  if (divHeaderIdx === -1) return;

  const headers = rawData[divHeaderIdx].slice(2).map((h) => (h || "").trim());

  const symbolIdx = findCol(headers, "symbol", "ticker");
  const dateIdx = findCol(headers, "date", "reportdate", "paydate", "pay date");
  const amountIdx = findCol(headers, "amount", "gross amount", "grossamount");
  const currIdx = findCol(headers, "currency", "currencyprimary");

  if (symbolIdx === -1 || amountIdx === -1) return;

  for (let i = divHeaderIdx + 1; i < rawData.length; i++) {
    const row = rawData[i];

    if (row[0]?.trim().toLowerCase() !== "dividends") break;
    if (row[1]?.trim().toLowerCase() !== "data") continue;

    const dataRow = row.slice(2);

    const raw: Record<string, string> = {};
    headers.forEach((h, idx) => {
      raw[h] = String(dataRow[idx] || "");
    });

    const rawDate = String(dataRow[dateIdx] || "").split(",")[0].split(" ")[0].trim();
    const dateStr =
      parseLocalDate(rawDate, "YYYYMMDD") ||
      parseLocalDate(rawDate, "YYYY-MM-DD");
    if (!dateStr) continue;

    const amount = parseLocalNumber(String(dataRow[amountIdx] || "0"), ".");
    if (!Number.isFinite(amount) || amount === 0) continue;

    rows.push({
      rowIndex: i + 1,
      date: dateStr,
      identifier: String(dataRow[symbolIdx] || "").trim(),
      identifierType: "ticker",
      type: "DIVIDEND",
      shares: 0, // Los dividendos no tienen cantidad de participaciones
      pricePerShare: 0,
      fees: 0,
      grossAmount: Math.abs(amount),
      currency: currIdx >= 0 ? String(dataRow[currIdx] || "").trim() || undefined : undefined,
      raw,
    });
  }
}

/**
 * Parsea un formato CSV simple de IB (una sola tabla sin secciones)
 */
function parseSimpleFormat(rawData: string[][], rows: ParsedRow[]) {
  if (rawData.length < 2) return;

  const headers = rawData[0].map((h) => (h || "").trim());

  const symbolIdx = findCol(headers, "symbol", "ticker");
  const dateIdx = findCol(headers, "date/time", "tradedate", "date", "datetime");
  const qtyIdx = findCol(headers, "quantity", "qty");
  const priceIdx = findCol(headers, "tradeprice", "price", "t. price");
  const feesIdx = findCol(headers, "ibcommission", "commission", "comm/fee", "comm");
  const currIdx = findCol(headers, "currencyprimary", "currency", "cur.");

  if (symbolIdx === -1 || qtyIdx === -1) return;

  for (let i = 1; i < rawData.length; i++) {
    const row = rawData[i];
    if (!row || row.every((cell) => !cell || String(cell).trim() === "")) continue;

    const raw: Record<string, string> = {};
    headers.forEach((h, idx) => {
      raw[h] = String(row[idx] || "");
    });

    const rawDate = String(row[dateIdx] || "").split(",")[0].split(" ")[0].trim();
    const dateStr =
      parseLocalDate(rawDate, "YYYYMMDD") ||
      parseLocalDate(rawDate, "YYYY-MM-DD") ||
      parseLocalDate(rawDate, "DD/MM/YYYY");
    if (!dateStr) continue;

    const qty = parseLocalNumber(String(row[qtyIdx] || "0"), ".");
    if (!Number.isFinite(qty) || qty === 0) continue;

    const type = qty > 0 ? "BUY" : "SELL";

    const price = priceIdx >= 0
      ? parseLocalNumber(String(row[priceIdx] || "0"), ".")
      : 0;
    if (!Number.isFinite(price)) continue;
    const rawFees = feesIdx >= 0
      ? parseLocalNumber(String(row[feesIdx] || "0"), ".")
      : 0;
    const fees = Number.isFinite(rawFees) ? rawFees : 0; // comisión ilegible → 0

    rows.push({
      rowIndex: i + 1,
      date: dateStr,
      identifier: String(row[symbolIdx] || "").trim(),
      identifierType: "ticker",
      type,
      shares: Math.abs(qty),
      pricePerShare: Math.abs(price),
      fees: Math.abs(fees),
      currency: currIdx >= 0 ? String(row[currIdx] || "").trim() || undefined : undefined,
      raw,
    });
  }
}
