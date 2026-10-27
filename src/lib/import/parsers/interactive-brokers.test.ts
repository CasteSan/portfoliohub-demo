/**
 * Tests del parser de Interactive Brokers — Fase A.1
 *
 * MODO PROFESOR — El Flex Query de IB:
 * Un solo CSV contiene VARIAS secciones (Statement, Trades, Dividends...).
 * Cada fila empieza con [nombre de sección, discriminador]: "Header" define
 * las columnas, "Data" son datos reales, y "SubTotal"/"Total" son agregados
 * que NO deben importarse. Es como un archivo FITS con varias extensiones:
 * hay que localizar la HDU correcta antes de leer la tabla.
 *
 * Fixture anonimizado pero fiel al formato documentado en el parser.
 */

import { describe, it, expect } from "vitest";
import { parseInteractiveBrokers } from "@/lib/import/parsers/interactive-brokers";

// ─────────────────────────────────────────────────────────────────────────────
// Fixture multi-sección
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE_MULTI: string[][] = [
  // Sección Statement (debe ignorarse por completo)
  ["Statement", "Header", "Field Name", "Field Value"],
  ["Statement", "Data", "BrokerName", "Interactive Brokers"],
  // Sección Trades — columnas tras "Trades","Header"
  ["Trades", "Header", "DataDiscriminator", "Asset Category", "Currency", "Symbol", "Date/Time", "Quantity", "T. Price", "Comm/Fee"],
  // idx 3 → compra de 10 AAPL
  ["Trades", "Data", "Order", "Stocks", "USD", "AAPL", "2024-03-15, 10:30:00", "10", "170.5", "-1"],
  // idx 4 → venta (qty negativa) de 5 MSFT
  ["Trades", "Data", "Order", "Stocks", "USD", "MSFT", "2024-03-16, 11:00:00", "-5", "400", "-1.25"],
  // idx 5 → forex: debe filtrarse
  ["Trades", "Data", "Order", "Forex", "USD", "EUR.USD", "2024-03-16, 11:05:00", "1000", "1.08", "-2"],
  // idx 6 → opciones: debe filtrarse
  ["Trades", "Data", "Order", "Options", "USD", "AAPL 240621C00200000", "2024-03-18, 12:00:00", "1", "5.5", "-0.65"],
  // idx 7 → cash: debe filtrarse
  ["Trades", "Data", "Order", "Cash", "USD", "USD.CASH", "2024-03-18, 13:00:00", "100", "1", "0"],
  // idx 8 → fecha inválida: se salta
  ["Trades", "Data", "Order", "Stocks", "USD", "TSLA", "fecha-rota", "5", "200", "0"],
  // idx 9 → qty 0: se salta
  ["Trades", "Data", "Order", "Stocks", "USD", "NFLX", "2024-03-19, 09:00:00", "0", "500", "0"],
  // idx 10 → SubTotal: NO es "Data", debe ignorarse
  ["Trades", "SubTotal", "", "Stocks", "USD", "", "", "5", "", ""],
  // Sección Dividends
  ["Dividends", "Header", "Currency", "Symbol", "Date", "Amount"],
  // idx 12 → dividendo válido
  ["Dividends", "Data", "USD", "AAPL", "2024-03-20", "12.34"],
  // idx 13 → amount 0: se salta
  ["Dividends", "Data", "USD", "MSFT", "2024-03-21", "0"],
  // idx 14 → amount negativo: se guarda en valor absoluto
  ["Dividends", "Data", "EUR", "SAN", "2024-04-01", "-7.5"],
  // idx 15 → fila vacía al final (PapaParse a veces la añade): no debe romper nada
  [],
];

describe("parseInteractiveBrokers — formato multi-sección", () => {
  it("extrae solo trades de Stocks y dividendos válidos (2 + 2)", () => {
    const rows = parseInteractiveBrokers(FIXTURE_MULTI);

    // Derivación: AAPL + MSFT (trades) + AAPL + SAN (dividendos) = 4 filas
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.identifier)).toEqual(["AAPL", "MSFT", "AAPL", "SAN"]);
  });

  it("qty positiva → BUY con datos correctos", () => {
    const rows = parseInteractiveBrokers(FIXTURE_MULTI);
    const aapl = rows[0];

    expect(aapl.type).toBe("BUY");
    expect(aapl.shares).toBe(10);
    expect(aapl.pricePerShare).toBeCloseTo(170.5, 10);
    // Comisión IB negativa (-1) → Math.abs → 1
    expect(aapl.fees).toBeCloseTo(1, 10);
    expect(aapl.currency).toBe("USD");
    expect(aapl.identifierType).toBe("ticker");
    // "2024-03-15, 10:30:00" → se corta por la coma → "2024-03-15"
    expect(aapl.date).toBe("2024-03-15");
    // La fila AAPL está en el índice 3 del array → rowIndex 4 (1-indexed)
    expect(aapl.rowIndex).toBe(4);
  });

  it("qty negativa → SELL con shares en valor absoluto", () => {
    const rows = parseInteractiveBrokers(FIXTURE_MULTI);
    const msft = rows[1];

    expect(msft.type).toBe("SELL");
    // Derivación: |-5| = 5
    expect(msft.shares).toBe(5);
    expect(msft.pricePerShare).toBeCloseTo(400, 10);
    expect(msft.fees).toBeCloseTo(1.25, 10);
    expect(msft.date).toBe("2024-03-16");
  });

  it("filtra forex, opciones y cash por Asset Category", () => {
    const rows = parseInteractiveBrokers(FIXTURE_MULTI);
    const tickers = rows.map((r) => r.identifier);

    expect(tickers).not.toContain("EUR.USD");
    expect(tickers).not.toContain("AAPL 240621C00200000");
    expect(tickers).not.toContain("USD.CASH");
  });

  it("ignora la fila SubTotal (solo procesa filas 'Data')", () => {
    const rows = parseInteractiveBrokers(FIXTURE_MULTI);

    // La fila SubTotal tiene qty "5" en su posición — si se procesara
    // aparecería una fila extra sin símbolo. No debe existir.
    expect(rows.filter((r) => r.identifier === "")).toHaveLength(0);
  });

  it("salta trades con fecha inválida o qty 0", () => {
    const rows = parseInteractiveBrokers(FIXTURE_MULTI);
    const tickers = rows.map((r) => r.identifier);

    expect(tickers).not.toContain("TSLA"); // fecha rota
    expect(tickers).not.toContain("NFLX"); // qty 0
  });

  it("dividendos: type DIVIDEND, shares 0 y grossAmount = |amount|", () => {
    const rows = parseInteractiveBrokers(FIXTURE_MULTI);
    const divAapl = rows[2];

    expect(divAapl.type).toBe("DIVIDEND");
    expect(divAapl.identifier).toBe("AAPL");
    // Los dividendos no tienen participaciones ni precio
    expect(divAapl.shares).toBe(0);
    expect(divAapl.pricePerShare).toBe(0);
    expect(divAapl.fees).toBe(0);
    expect(divAapl.grossAmount).toBeCloseTo(12.34, 10);
    expect(divAapl.date).toBe("2024-03-20");
    expect(divAapl.currency).toBe("USD");
    // Índice 12 del array → rowIndex 13
    expect(divAapl.rowIndex).toBe(13);
  });

  it("dividendo con amount 0 se salta; amount negativo → valor absoluto", () => {
    const rows = parseInteractiveBrokers(FIXTURE_MULTI);
    const dividends = rows.filter((r) => r.type === "DIVIDEND");

    // MSFT (amount 0) fuera; SAN (-7.5) dentro con |−7.5| = 7.5
    expect(dividends.map((r) => r.identifier)).toEqual(["AAPL", "SAN"]);
    expect(dividends[1].grossAmount).toBeCloseTo(7.5, 10);
    expect(dividends[1].currency).toBe("EUR");
  });

  it("raw conserva las columnas de la sección (sin 'Trades'/'Data')", () => {
    const rows = parseInteractiveBrokers(FIXTURE_MULTI);

    expect(rows[0].raw["Symbol"]).toBe("AAPL");
    expect(rows[0].raw["Quantity"]).toBe("10");
    expect(rows[0].raw["Asset Category"]).toBe("Stocks");
  });

  it("multi-sección sin columnas Symbol/Quantity en Trades → solo dividendos", () => {
    const rawData: string[][] = [
      // Header de Trades sin las columnas mínimas (symbol + quantity)
      ["Trades", "Header", "DataDiscriminator", "Asset Category"],
      ["Trades", "Data", "Order", "Stocks"],
      ["Dividends", "Header", "Currency", "Symbol", "Date", "Amount"],
      ["Dividends", "Data", "USD", "AAPL", "2024-03-20", "12.34"],
    ];

    const rows = parseInteractiveBrokers(rawData);

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("DIVIDEND");
  });

  it("multi-sección sin sección Dividends → solo trades", () => {
    const rawData: string[][] = [
      ["Trades", "Header", "DataDiscriminator", "Asset Category", "Currency", "Symbol", "Date/Time", "Quantity", "T. Price", "Comm/Fee"],
      ["Trades", "Data", "Order", "Stocks", "USD", "AAPL", "20240315", "10", "170.5", "-1"],
    ];

    const rows = parseInteractiveBrokers(rawData);

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("BUY");
    // Fecha en formato compacto YYYYMMDD → 2024-03-15
    expect(rows[0].date).toBe("2024-03-15");
  });

  it("trades con columnas mínimas: sin precio/comisión/divisa/asset → defaults", () => {
    const rawData: string[][] = [
      // Header sin T. Price, Comm/Fee, Currency ni Asset Category
      ["Trades", "Header", "Symbol", "Date/Time", "Quantity"],
      ["Trades", "Data", "AAPL", "20240315", "10"],
      // Sección Dividends sin columna Amount → se ignora entera
      ["Dividends", "Header", "Symbol", "Date"],
      ["Dividends", "Data", "AAPL", "2024-03-20"],
    ];

    const rows = parseInteractiveBrokers(rawData);

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("BUY");
    expect(rows[0].pricePerShare).toBe(0);
    expect(rows[0].fees).toBe(0);
    expect(rows[0].currency).toBeUndefined();
  });

  it("dividendos sin columna Currency → currency undefined", () => {
    const rawData: string[][] = [
      ["Trades", "Header", "DataDiscriminator", "Asset Category", "Currency", "Symbol", "Date/Time", "Quantity", "T. Price", "Comm/Fee"],
      ["Dividends", "Header", "Symbol", "Date", "Amount"],
      ["Dividends", "Data", "AAPL", "2024-03-20", "12.34"],
    ];

    const rows = parseInteractiveBrokers(rawData);

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("DIVIDEND");
    expect(rows[0].currency).toBeUndefined();
    expect(rows[0].grossAmount).toBeCloseTo(12.34, 10);
  });

  it("multi: celdas de precio, comisión y divisa vacías → 0 / undefined", () => {
    const rawData: string[][] = [
      ["Trades", "Header", "DataDiscriminator", "Asset Category", "Currency", "Symbol", "Date/Time", "Quantity", "T. Price", "Comm/Fee"],
      ["Trades", "Data", "Order", "Stocks", "", "ITX", "2024-03-22, 10:00:00", "2", "", ""],
    ];

    const rows = parseInteractiveBrokers(rawData);

    expect(rows).toHaveLength(1);
    expect(rows[0].identifier).toBe("ITX");
    expect(rows[0].pricePerShare).toBe(0);
    expect(rows[0].fees).toBe(0);
    expect(rows[0].currency).toBeUndefined();
  });

  it("celdas no numéricas → fila rechazada o fees=0, nunca NaN (fix post-fase-A)", () => {
    // `NaN === 0` y `NaN <= 0` son false: sin Number.isFinite, una qty o un
    // precio ilegibles colaban la fila con NaN. La comisión, por ser opcional,
    // se normaliza a 0 en vez de tirar la fila.
    const rawData: string[][] = [
      ["Trades", "Header", "DataDiscriminator", "Asset Category", "Currency", "Symbol", "Date/Time", "Quantity", "T. Price", "Comm/Fee"],
      // Quantity ilegible → fuera
      ["Trades", "Data", "Order", "Stocks", "USD", "AAPL", "2024-03-22, 10:00:00", "N/A", "100", "-1"],
      // Precio ilegible → fuera
      ["Trades", "Data", "Order", "Stocks", "USD", "MSFT", "2024-03-22, 11:00:00", "5", "err", "-1"],
      // Comisión ilegible → entra con fees = 0
      ["Trades", "Data", "Order", "Stocks", "USD", "ITX", "2024-03-22, 12:00:00", "2", "30", "n/d"],
      ["Dividends", "Header", "Symbol", "Date", "Amount"],
      // Amount ilegible → fuera (NaN === 0 es false, antes se colaba)
      ["Dividends", "Data", "AAPL", "2024-03-20", "pendiente"],
    ];

    const rows = parseInteractiveBrokers(rawData);

    expect(rows).toHaveLength(1);
    expect(rows[0].identifier).toBe("ITX");
    expect(rows[0].shares).toBe(2);
    expect(rows[0].fees).toBe(0);
  });

  it("trades multi con celdas vacías: fecha/qty vacías → salta; símbolo/asset vacíos → se conservan", () => {
    const rawData: string[][] = [
      // Fila degenerada "Trades" sin discriminador (no debe romper la detección)
      ["Trades"],
      // Header con celda vacía colgante al final
      ["Trades", "Header", "DataDiscriminator", "Asset Category", "Currency", "Symbol", "Date/Time", "Quantity", "T. Price", "Comm/Fee", ""],
      // Fecha vacía → se salta
      ["Trades", "Data", "Order", "Stocks", "USD", "REP", "", "3", "10", "0"],
      // Símbolo vacío → la fila se conserva con identifier ""
      ["Trades", "Data", "Order", "Stocks", "USD", "", "20240315", "3", "10", "0"],
      // Qty vacía → 0 → se salta
      ["Trades", "Data", "Order", "Stocks", "USD", "SAN", "20240315", "", "10", "0"],
      // Asset Category vacía → NO se filtra (solo se filtran forex/cash/options)
      ["Trades", "Data", "Order", "", "USD", "MAP", "20240315", "1", "5", "0"],
    ];

    const rows = parseInteractiveBrokers(rawData);

    expect(rows).toHaveLength(2);
    expect(rows[0].identifier).toBe("");
    expect(rows[1].identifier).toBe("MAP");
  });

  it("dividendos con celdas vacías: fecha/amount vacíos → salta; símbolo/divisa vacíos → '' / undefined", () => {
    const rawData: string[][] = [
      // Sección Trades mínima para forzar la detección multi-sección
      ["Trades", "Header", "Symbol", "Date/Time", "Quantity"],
      ["Dividends", "Header", "Currency", "Symbol", "Date", "Amount", ""],
      // Símbolo y divisa vacíos → identifier "" y currency undefined
      ["Dividends", "Data", "", "", "2024-03-20", "5"],
      // Fecha vacía → se salta
      ["Dividends", "Data", "USD", "AAPL", "", "5"],
      // Amount vacío → 0 → se salta
      ["Dividends", "Data", "USD", "AAPL", "2024-03-21", ""],
    ];

    const rows = parseInteractiveBrokers(rawData);

    expect(rows).toHaveLength(1);
    expect(rows[0].identifier).toBe("");
    expect(rows[0].currency).toBeUndefined();
    expect(rows[0].grossAmount).toBeCloseTo(5, 10);
  });

  it("sección Dividends ANTES de Trades: ambas se parsean igual (orden independiente)", () => {
    // El parser escanea el archivo dos veces (una buscando "Trades,Header" y
    // otra "Dividends,Header"), así que el orden físico de las secciones no
    // debe importar. Además, el loop de Dividends debe PARAR (break) al topar
    // con la fila "Trades,Header" sin tragarse las filas de trades.
    const rawData: string[][] = [
      ["Dividends", "Header", "Currency", "Symbol", "Date", "Amount"],
      ["Dividends", "Data", "USD", "AAPL", "2024-03-20", "12.34"],
      ["Trades", "Header", "DataDiscriminator", "Asset Category", "Currency", "Symbol", "Date/Time", "Quantity", "T. Price", "Comm/Fee"],
      ["Trades", "Data", "Order", "Stocks", "USD", "MSFT", "20240316", "-5", "400", "-1.25"],
    ];

    const rows = parseInteractiveBrokers(rawData);

    expect(rows).toHaveLength(2);
    // Los trades se emiten primero (se parsean antes), aunque en el archivo
    // la sección Dividends vaya delante
    expect(rows[0].identifier).toBe("MSFT");
    expect(rows[0].type).toBe("SELL");
    // rowIndex conserva la posición REAL en el archivo: MSFT en índice 3 → fila 4
    expect(rows[0].rowIndex).toBe(4);
    expect(rows[1].identifier).toBe("AAPL");
    expect(rows[1].type).toBe("DIVIDEND");
    expect(rows[1].grossAmount).toBeCloseTo(12.34, 10);
    // AAPL en índice 1 → fila 2
    expect(rows[1].rowIndex).toBe(2);
  });

  it("dividendo con fecha inválida se salta", () => {
    const rawData: string[][] = [
      ["Trades", "Header", "DataDiscriminator", "Asset Category", "Currency", "Symbol", "Date/Time", "Quantity", "T. Price", "Comm/Fee"],
      ["Trades", "Data", "Order", "Stocks", "USD", "AAPL", "20240315", "10", "170.5", "-1"],
      ["Dividends", "Header", "Currency", "Symbol", "Date", "Amount"],
      ["Dividends", "Data", "USD", "KO", "rota", "5"],
    ];

    const rows = parseInteractiveBrokers(rawData);

    expect(rows.filter((r) => r.type === "DIVIDEND")).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Formato simple (una sola tabla, sin secciones)
// ─────────────────────────────────────────────────────────────────────────────

describe("parseInteractiveBrokers — formato simple", () => {
  const FIXTURE_SIMPLE: string[][] = [
    // Header con celda vacía al final (PapaParse las genera con comas colgantes)
    ["Symbol", "Date", "Quantity", "TradePrice", "IBCommission", "CurrencyPrimary", ""],
    // idx 1 → fecha compacta YYYYMMDD
    ["AAPL", "20240315", "10", "170.5", "-1", "USD"],
    // idx 2 → fecha "YYYY-MM-DD, HH:MM:SS" → se corta por la coma
    ["MSFT", "2024-03-16, 11:00:00", "-5", "400", "-1.25", "USD"],
    // idx 3 → fila vacía: se salta
    ["", "", "", "", "", ""],
    // idx 4 → fecha inválida: se salta
    ["TSLA", "fecha-rota", "5", "200", "0", "USD"],
    // idx 5 → qty 0: se salta
    ["NFLX", "20240320", "0", "500", "0", "USD"],
    // idx 6 → fecha DD/MM/YYYY (tercer fallback)
    ["SAN", "31/12/2024", "20", "4.5", "-0.5", "EUR"],
    // idx 7 → fecha "YYYY-MM-DD HH:MM:SS" → se corta por el espacio
    ["IBE", "2024-03-18 09:30:00", "15", "11.2", "0", "EUR"],
    // idx 8 → celda de cantidad vacía → qty 0 → se salta
    ["AMZN", "20240321", "", "100", "0", "USD"],
    // idx 9 → fila parcial (solo símbolo, sin fecha) → se salta
    ["KO"],
    // idx 10 → celda de divisa vacía → currency undefined
    ["BBVA", "20240322", "8", "9.1", "0", ""],
  ];

  it("detecta el formato simple (sin fila 'Trades,Header') y parsea la tabla", () => {
    const rows = parseInteractiveBrokers(FIXTURE_SIMPLE);

    // Derivación: AAPL, MSFT, SAN, IBE, BBVA = 5 válidas
    // (vacía, TSLA, NFLX, AMZN y KO se saltan)
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.identifier)).toEqual(["AAPL", "MSFT", "SAN", "IBE", "BBVA"]);
  });

  it("celda de divisa vacía → currency undefined", () => {
    const rows = parseInteractiveBrokers(FIXTURE_SIMPLE);
    const bbva = rows[4];

    expect(bbva.currency).toBeUndefined();
    expect(bbva.date).toBe("2024-03-22");
    // BBVA está en el índice 10 del array → rowIndex 11
    expect(bbva.rowIndex).toBe(11);
  });

  it("formato simple con columnas mínimas → price 0, fees 0, currency undefined", () => {
    const rawData: string[][] = [
      ["Symbol", "Date", "Quantity"],
      ["AAPL", "20240315", "10"],
    ];

    const rows = parseInteractiveBrokers(rawData);

    expect(rows).toHaveLength(1);
    expect(rows[0].pricePerShare).toBe(0);
    expect(rows[0].fees).toBe(0);
    expect(rows[0].currency).toBeUndefined();
  });

  it("celdas de precio y comisión vacías → 0", () => {
    const rawData: string[][] = [
      ["Symbol", "Date", "Quantity", "TradePrice", "IBCommission", "CurrencyPrimary"],
      ["TEF", "20240315", "5", "", "", "EUR"],
    ];

    const rows = parseInteractiveBrokers(rawData);

    expect(rows).toHaveLength(1);
    expect(rows[0].pricePerShare).toBe(0);
    expect(rows[0].fees).toBe(0);
    expect(rows[0].currency).toBe("EUR");
  });

  it("parsea fecha compacta YYYYMMDD", () => {
    const rows = parseInteractiveBrokers(FIXTURE_SIMPLE);

    expect(rows[0].date).toBe("2024-03-15");
    expect(rows[0].type).toBe("BUY");
    expect(rows[0].shares).toBe(10);
    // rowIndex: header = fila 1, AAPL = fila 2
    expect(rows[0].rowIndex).toBe(2);
  });

  it("corta la fecha por coma y por espacio antes de parsear", () => {
    const rows = parseInteractiveBrokers(FIXTURE_SIMPLE);

    // "2024-03-16, 11:00:00" → "2024-03-16"
    expect(rows[1].date).toBe("2024-03-16");
    // "2024-03-18 09:30:00" → "2024-03-18"
    expect(rows[3].date).toBe("2024-03-18");
  });

  it("acepta DD/MM/YYYY como tercer fallback de fecha", () => {
    const rows = parseInteractiveBrokers(FIXTURE_SIMPLE);
    const san = rows[2];

    // "31/12/2024" no encaja en YYYYMMDD ni YYYY-MM-DD → DD/MM/YYYY
    expect(san.date).toBe("2024-12-31");
    expect(san.currency).toBe("EUR");
  });

  it("qty negativa → SELL y comisiones IB negativas → Math.abs", () => {
    const rows = parseInteractiveBrokers(FIXTURE_SIMPLE);
    const msft = rows[1];

    expect(msft.type).toBe("SELL");
    // Derivación: |-5| = 5 participaciones
    expect(msft.shares).toBe(5);
    // Derivación: |-1.25| = 1.25 de comisión
    expect(msft.fees).toBeCloseTo(1.25, 10);
  });

  it("raw conserva las columnas originales", () => {
    const rows = parseInteractiveBrokers(FIXTURE_SIMPLE);

    expect(rows[0].raw["Symbol"]).toBe("AAPL");
    expect(rows[0].raw["Quantity"]).toBe("10");
    expect(rows[0].raw["IBCommission"]).toBe("-1");
  });

  it("devuelve [] si faltan columnas mínimas (Symbol/Quantity)", () => {
    const rawData: string[][] = [
      ["Symbol", "Date", "Price"],
      ["AAPL", "20240315", "170.5"],
    ];

    expect(parseInteractiveBrokers(rawData)).toHaveLength(0);
  });

  it("devuelve [] con input vacío o solo header", () => {
    expect(parseInteractiveBrokers([])).toHaveLength(0);
    expect(
      parseInteractiveBrokers([["Symbol", "Date", "Quantity", "TradePrice"]])
    ).toHaveLength(0);
  });
});
