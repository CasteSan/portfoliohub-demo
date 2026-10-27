/**
 * Tipos e interfaces para proveedores de precios
 *
 * Este módulo define una interfaz abstracta que permite cambiar
 * de proveedor de datos (Yahoo Finance, EODHD, FMP) sin modificar
 * el resto del código. Es el patrón "Adapter" o "Strategy".
 *
 * Analogía: Es como tener un "puerto USB" estándar - cualquier
 * dispositivo que cumpla la especificación puede conectarse.
 */

/**
 * Respuesta de una consulta de precio
 */
export type PriceQuote = {
  /** Precio actual del instrumento */
  price: number;
  /** Divisa del precio (USD, EUR, GBP, etc.) */
  currency: string;
  /** Nombre del instrumento según el proveedor */
  name: string;
  /** Timestamp de la última actualización (opcional) */
  timestamp?: Date;
  /** Cambio respecto al cierre anterior (opcional) */
  change?: number;
  /** Cambio porcentual (opcional) */
  changePercent?: number;
  /** Precio de cierre anterior (opcional) */
  previousClose?: number;
  /**
   * Fecha del DATO (no de la consulta): el VL de un fondo es de T-1/T-2.
   * El cron guarda el precio en esta fecha, no como cierre de hoy (E.1).
   */
  asOf?: Date;
  /** Proveedor que lo sirvió ("yahoo", "morningstar") — lo rellena el registro */
  source?: string;
};

/**
 * Lo mínimo de un instrumento para elegir proveedor y pedirle datos (E.1).
 * Encaja estructuralmente con la fila `Instrument` de Prisma, así que los
 * consumidores pasan `position.instrument` tal cual.
 */
export type InstrumentRef = {
  id: string;
  ticker: string | null;
  isin: string | null;
  /** STOCK, ETF, FUND, INDEX, BOND… — decide la ruta en el registro */
  typeId: string;
  /** Divisa del instrumento (ya normalizada: GBP, no GBp) */
  currency: string;
  /** Cachés por proveedor (p.ej. `morningstarSecId`) */
  metadata?: unknown;
};

/**
 * Proveedor de PRECIOS del registro (Fase E.1): quote + histórico.
 *
 * Para añadir un proveedor (p.ej. EODHD, plan B de la decisión 7):
 * 1. Un archivo que implemente esta interfaz
 * 2. Una entrada en `ROUTING` de `registry.ts`
 * Nada más: los consumidores hablan con el registro, no con el proveedor.
 *
 * Contrato: `supports()` es barato y síncrono (solo mira la ref); los
 * métodos async devuelven null/vacío ante fallo, el registro además los
 * envuelve en try/catch — un proveedor roto nunca tumba al consumidor.
 */
export interface PriceProvider {
  /** Nombre corto, estable: aparece en CronLog y en `source` */
  readonly name: string;
  /** ¿Puede este proveedor servir a este instrumento? (ticker, ISIN, tipo…) */
  supports(ref: InstrumentRef): boolean;
  getQuote(ref: InstrumentRef): Promise<PriceQuote | null>;
  /** Map de ref.id → quote (los que fallen no aparecen) */
  getQuotes(refs: InstrumentRef[]): Promise<Map<string, PriceQuote>>;
  getHistory(
    ref: InstrumentRef,
    period: HistoricalPeriod
  ): Promise<HistoricalDataPoint[] | null>;
}

/**
 * Interfaz LEGADA por ticker (antes de E.1): la implementa la clase de Yahoo
 * y la usan sus helpers (`getYahooQuote`, búsqueda, perfil…). Los precios
 * del cron y de los gráficos ya no pasan por aquí sino por el registro.
 */
export interface TickerPriceProvider {
  /** Nombre del proveedor para logs y debugging */
  readonly name: string;

  /**
   * Obtiene el precio actual de un instrumento por su ticker.
   *
   * @param ticker - Símbolo del instrumento (ej: "AAPL", "SAN.MC")
   * @returns Datos del precio o null si no se encuentra/falla
   */
  getQuote(ticker: string): Promise<PriceQuote | null>;

  /**
   * Obtiene precios de múltiples instrumentos de una vez.
   * Útil para actualizar todas las posiciones de un usuario.
   *
   * @param tickers - Array de símbolos
   * @returns Map de ticker → precio (los que fallen no aparecen)
   */
  getQuotes(tickers: string[]): Promise<Map<string, PriceQuote>>;

  /**
   * Busca instrumentos por nombre, ticker o ISIN en el proveedor externo.
   * Opcional: no todos los proveedores soportan búsqueda.
   *
   * @param query - Texto de búsqueda
   * @param maxResults - Máximo de resultados (default 8)
   * @returns Array de resultados o [] si falla/no soportado
   */
  searchInstruments?(query: string, maxResults?: number): Promise<YahooSearchResult[]>;
}

/**
 * Resultado de una operación de actualización masiva de precios
 */
export type PriceUpdateResult = {
  /** Número de precios actualizados correctamente */
  updated: number;
  /** Número de precios que fallaron */
  failed: number;
  /** Lista de errores (ticker + mensaje) */
  errors: Array<{ ticker: string; error: string }>;
  /** Timestamp de la actualización */
  timestamp: Date;
};

/**
 * Periodos disponibles para datos históricos
 */
export type HistoricalPeriod = "1M" | "3M" | "6M" | "YTD" | "1Y" | "5Y";

/**
 * Punto de datos histórico (un día)
 */
export type HistoricalDataPoint = {
  /** Fecha del dato */
  date: Date;
  /** Precio de cierre */
  close: number;
  /** Precio de apertura (opcional) */
  open?: number;
  /** Máximo del día (opcional) */
  high?: number;
  /** Mínimo del día (opcional) */
  low?: number;
  /** Volumen (opcional) */
  volume?: number;
};

/**
 * Punto de datos para gráfico de evolución de cartera
 */
export type EvolutionDataPoint = {
  /** Fecha */
  date: string; // ISO string para serialización JSON
  /** Valor de mercado total */
  value: number;
  /** Dinero invertido (cost basis) — para comparar con value */
  invested: number;
  /**
   * Flujo externo NETO ACUMULADO a precios de transacción:
   * BUY/TRANSFER_IN suman shares×precio, SELL/TRANSFER_OUT lo restan.
   *
   * A diferencia de `invested` (cost basis: una venta retira el coste medio,
   * no los ingresos), el Δ de cumFlow entre dos puntos es el dinero que de
   * verdad entró/salió — la base correcta del cashflow del TWR (micro-fase
   * fix-twr-cashflows). Es ACUMULADO para sobrevivir al downsampling sin
   * agregación por bucket: Δ entre cierres semanales = suma de los flujos
   * intermedios.
   */
  cumFlow: number;
};

/**
 * Resultado de búsqueda de Yahoo Finance.
 * Datos del endpoint /v1/finance/search antes de crear un instrumento local.
 */
export type YahooSearchResult = {
  /** Símbolo con sufijo de mercado (ej: "SAN.MC", "TSLA") */
  symbol: string;
  /** Nombre corto del instrumento */
  shortname: string;
  /** Nombre completo (puede no estar disponible) */
  longname?: string;
  /** Código del exchange (ej: "MCE", "NMS") */
  exchange: string;
  /** Tipo de instrumento Yahoo (ej: "EQUITY", "ETF", "MUTUALFUND") */
  quoteType: string;
};

/**
 * Perfil completo de un instrumento obtenido de Yahoo Finance quoteSummary.
 *
 * MODO PROFESOR — quoteSummary API:
 * Yahoo Finance tiene un endpoint "quoteSummary" que devuelve módulos de datos.
 * Cada módulo es un bloque temático: `price` (precio actual), `assetProfile`
 * (info corporativa), `summaryDetail` (métricas de mercado), etc.
 * Pedimos varios módulos en una sola llamada separados por coma.
 *
 * No todos los instrumentos tienen todos los campos. Las acciones (EQUITY) suelen
 * tener assetProfile (sede, web, sector), pero los ETFs/fondos no.
 * Por eso casi todo es opcional (?).
 */
export type InstrumentProfile = {
  // === Precio actual (módulo "price") ===
  regularMarketPrice: number;
  regularMarketChange: number;
  regularMarketChangePercent: number;
  currency: string;
  exchangeName: string;

  // === Rango de precios (módulo "summaryDetail") ===
  previousClose?: number;
  open?: number;
  dayLow?: number;
  dayHigh?: number;
  fiftyTwoWeekLow?: number;
  fiftyTwoWeekHigh?: number;

  // === Volumen ===
  volume?: number;
  averageVolume?: number;

  // === Valoración ===
  marketCap?: number;
  trailingPE?: number;
  forwardPE?: number;
  priceToBook?: number;
  enterpriseValue?: number;

  // === Dividendos / Rendimiento ===
  dividendYield?: number;
  trailingEps?: number;
  forwardEps?: number;
  beta?: number;
  profitMargins?: number;

  // === Info corporativa (módulo "assetProfile") ===
  sector?: string;
  industry?: string;
  website?: string;
  longBusinessSummary?: string;
  fullTimeEmployees?: number;
  city?: string;
  state?: string;
  country?: string;
  address?: string;
};
