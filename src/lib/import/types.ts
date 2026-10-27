/**
 * Tipos para importación de CSV/Excel
 *
 * Define las estructuras de datos que fluyen por el pipeline de importación:
 * Archivo → Parser → ParsedRow[] → Resolución → PreviewRow[] → ImportRequest → ImportResult
 */

/** Formatos de broker soportados */
export type BrokerFormat = "generic" | "myinvestor" | "interactive-brokers";

/** Separadores decimales */
export type DecimalSeparator = "." | ",";

/** Formatos de fecha soportados */
export type DateFormat = "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD" | "YYYYMMDD" | "M/D/YY";

/**
 * Fila parseada por un parser de broker.
 * Esta es la salida estándar que todos los parsers producen.
 */
export type ParsedRow = {
  /** Número de fila original en el archivo (para reportar errores) */
  rowIndex: number;
  /** Fecha en formato ISO (YYYY-MM-DD) */
  date: string;
  /** Identificador del instrumento (ISIN, ticker, o nombre) */
  identifier: string;
  /** Qué tipo de identificador es */
  identifierType: "isin" | "ticker" | "name";
  /** Nombre del instrumento (si está disponible en el CSV) */
  name?: string;
  /** Tipo de operación normalizado */
  type: "BUY" | "SELL" | "DIVIDEND" | "TRANSFER_IN" | "TRANSFER_OUT";
  /** Participaciones (siempre positivo) */
  shares: number;
  /** Precio por unidad */
  pricePerShare: number;
  /** Comisiones */
  fees: number;
  /** Divisa (EUR, USD, etc.) */
  currency?: string;
  /** Importe bruto del dividendo */
  grossAmount?: number;
  /** Retención en origen */
  withholdingTax?: number;
  /** País de retención */
  withholdingCountry?: string;
  /** Notas adicionales */
  notes?: string;
  /** Columnas originales del CSV (para debugging) */
  raw: Record<string, string>;
};

/**
 * Fila enriquecida con resolución de instrumento.
 * Se usa en la vista previa antes de importar.
 */
export type PreviewRow = ParsedRow & {
  /** Estado de la fila */
  status: "ready" | "skip" | "error" | "warning";
  /** ID del instrumento resuelto */
  instrumentId?: string;
  /** Nombre del instrumento resuelto */
  instrumentName?: string;
  /** Cómo se resolvió el instrumento */
  resolvedVia?: "isin" | "ticker" | "name" | "yahoo";
  /** Mensaje de error */
  error?: string;
  /** Mensaje de advertencia */
  warning?: string;
};

/**
 * Mapeo de columnas CSV → campos de la app.
 * Solo se usa con el parser genérico.
 */
export type ColumnMapping = {
  date: string;
  identifier: string;
  identifierType: "isin" | "ticker" | "name";
  type: string;
  shares: string;
  pricePerShare: string;
  fees?: string;
  currency?: string;
  notes?: string;
};

/**
 * Mapeo de valores de tipo de operación del CSV a nuestros tipos.
 * Ejemplo: { "Compra": "BUY", "Venta": "SELL", "Dividendo": "DIVIDEND" }
 */
export type TypeMapping = Record<string, "BUY" | "SELL" | "DIVIDEND" | "TRANSFER_IN" | "TRANSFER_OUT" | "SKIP">;

/**
 * Request para la API de resolución de instrumentos (preview)
 */
export type ResolveRequest = {
  rows: Array<{
    identifier: string;
    identifierType: "isin" | "ticker" | "name";
    name?: string;
    /** Divisa de la fila: elige el listado al auto-crear (E.7) */
    currency?: string;
  }>;
};

/**
 * Respuesta de resolución de instrumentos
 */
export type ResolveResponse = {
  resolutions: Array<{
    identifier: string;
    instrumentId: string | null;
    instrumentName: string | null;
    resolvedVia: "isin" | "ticker" | "name" | "yahoo" | null;
    error?: string;
    /** Listado auto-creado cuya divisa no es la del CSV (E.7) */
    currencyCheck?: { symbol: string; listingCurrency: string | null; csvCurrency: string };
  }>;
};

/**
 * Request para la API de importación
 */
export type ImportRequest = {
  rows: Array<{
    date: string;
    instrumentId: string;
    type: "BUY" | "SELL" | "DIVIDEND" | "TRANSFER_IN" | "TRANSFER_OUT";
    shares: number;
    pricePerShare: number;
    fees: number;
    notes?: string;
    grossAmount?: number;
    withholdingTax?: number;
    withholdingCountry?: string;
  }>;
};

/**
 * Resultado de la importación
 */
export type ImportResult = {
  imported: number;
  skipped: number;
  errors: Array<{
    rowIndex: number;
    error: string;
  }>;
};

/**
 * Interfaz que deben implementar todos los parsers de broker
 */
export type ParserFunction = (
  rawData: string[][],
  options?: { decimalSeparator?: DecimalSeparator }
) => ParsedRow[];
