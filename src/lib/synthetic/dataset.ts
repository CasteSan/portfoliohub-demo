/**
 * Synthetic dataset generator (PURE, deterministic).
 *
 * Produces a complete, internally consistent set of users, portfolios,
 * instruments, daily prices, ECB-style FX rates, transactions, positions and
 * monthly snapshots from a numeric seed. Nothing here touches the database:
 * `prisma/seed-demo.ts` writes the result, and the same data feeds
 * screenshots and tests. Every instrument, ISIN, name and figure is invented.
 *
 * Why a pure generator and not a SQL dump: the dump would freeze one state;
 * the generator can be regenerated for any date range, is cheap to test
 * (same seed, same output; no sale exceeds the holding; every transfer pair
 * balances) and never carries anything personal by construction.
 *
 * Conventions mirror the application:
 * - BUY/TRANSFER_IN cost = shares x price + fees; SELL proceeds = shares x price - fees.
 * - Average cost does not change on a sale; it is recomputed on a purchase
 *   with fees prorated into the effective price (portfolio-utils).
 * - avgCostBase: cost in the portfolio currency at the FX rate of each trade
 *   date (ECB convention: rate = units of quote per 1 EUR).
 * - Fund transfers (traspaso) move the same number of shares at the fiscal
 *   cost of the origin (pricePerShare = origin avgCost), fees 0, with the
 *   taxMetadata the FIFO engine reads.
 * - DIVIDEND: grossAmount, withholdingTax, totalAmount = net.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SyntheticRole = "ADMIN" | "CLIENT";
export type SyntheticCurrency = "EUR" | "USD";
export type SyntheticTypeId = "STOCK" | "ETF" | "FUND";
export type SyntheticTxType =
  | "BUY"
  | "SELL"
  | "DIVIDEND"
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  | "FEE";

export type SyntheticUser = {
  key: string;
  email: string;
  name: string;
  role: SyntheticRole;
};

export type SyntheticPortfolio = {
  key: string;
  owner: string;
  name: string;
  description: string;
  currency: SyntheticCurrency;
};

export type SyntheticFundDetails = {
  category: string;
  managementCompany: string;
  /** TER as a fraction (0.0018 = 0.18%) */
  expenseRatio: number;
  /** CNMV scale "1".."7" */
  riskLevel: string;
  sectorWeights: Record<string, number>;
  countryAllocation: Record<string, number>;
  topHoldings: Array<{ name: string; ticker: string | null; weight: number }>;
};

export type SyntheticInstrument = {
  key: string;
  isin: string;
  ticker: string | null;
  name: string;
  typeId: SyntheticTypeId;
  exchange: string | null;
  currency: SyntheticCurrency;
  fund: SyntheticFundDetails | null;
  /** Price model parameters (geometric random walk) */
  model: { start: number; drift: number; vol: number };
  /** Annual dividend yield, paid twice a year (null = no dividends) */
  dividend: { yieldAnnual: number; withholdingRate: number; country: string } | null;
};

export type SyntheticPrice = {
  instrument: string;
  /** yyyy-mm-dd */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type SyntheticFxRate = {
  date: string;
  base: "EUR";
  quote: SyntheticCurrency;
  rate: number;
};

export type SyntheticTransaction = {
  portfolio: string;
  instrument: string;
  type: SyntheticTxType;
  date: string;
  shares: number;
  pricePerShare: number;
  fees: number;
  totalAmount: number;
  notes?: string;
  grossAmount?: number;
  withholdingTax?: number;
  withholdingRate?: number;
  withholdingCountry?: string;
  /** Both legs of a fund transfer share this key */
  transferPair?: string;
  /** TRANSFER_IN / TRANSFER_OUT: fiscal cost per share dragged from the origin */
  fiscalCostDragged?: number;
  /** TRANSFER_IN: the same cost already in the portfolio currency */
  fiscalCostDraggedBase?: number;
};

export type SyntheticPosition = {
  portfolio: string;
  instrument: string;
  shares: number;
  avgCost: number;
  avgCostBase: number;
  currentPrice: number;
};

export type SyntheticSnapshot = {
  portfolio: string;
  date: string;
  totalValue: number;
  totalInvested: number;
  byInstrument: Array<{ instrument: string; value: number }>;
};

export type SyntheticDataset = {
  meta: { seed: number; start: string; end: string };
  users: SyntheticUser[];
  portfolios: SyntheticPortfolio[];
  instruments: SyntheticInstrument[];
  prices: SyntheticPrice[];
  fxRates: SyntheticFxRate[];
  transactions: SyntheticTransaction[];
  positions: SyntheticPosition[];
  snapshots: SyntheticSnapshot[];
};

export type SyntheticOptions = {
  seed?: number;
  /** First business day of prices and FX (yyyy-mm-dd) */
  start?: string;
  /** Last day of prices, FX and snapshots (yyyy-mm-dd) */
  end?: string;
};

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/** mulberry32: small, fast, good enough for synthetic data */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller */
function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function toKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fromKey(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

function addDays(key: string, days: number): string {
  const d = fromKey(key);
  d.setUTCDate(d.getUTCDate() + days);
  return toKey(d);
}

function isBusinessDay(key: string): boolean {
  const dow = fromKey(key).getUTCDay();
  return dow !== 0 && dow !== 6;
}

/** Business days (Mon-Fri) between start and end, inclusive */
export function businessDays(start: string, end: string): string[] {
  const out: string[] = [];
  for (let k = start; k <= end; k = addDays(k, 1)) {
    if (isBusinessDay(k)) out.push(k);
  }
  return out;
}

/** First business day on or after `key` within the calendar (or null) */
function onOrAfter(calendar: string[], key: string): string | null {
  for (const k of calendar) if (k >= key) return k;
  return null;
}

function lastBusinessDayOfMonth(calendar: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < calendar.length; i++) {
    const next = calendar[i + 1];
    if (!next || next.slice(0, 7) !== calendar[i].slice(0, 7)) out.push(calendar[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ISIN with a valid check digit (fictitious prefix)
// ---------------------------------------------------------------------------

/** Luhn check digit over the ISIN body (letters expanded to two digits) */
export function isinCheckDigit(body: string): string {
  const digits: number[] = [];
  for (const ch of body.toUpperCase()) {
    if (ch >= "0" && ch <= "9") digits.push(Number(ch));
    else {
      const v = ch.charCodeAt(0) - 55; // A=10 ... Z=35
      digits.push(Math.floor(v / 10), v % 10);
    }
  }
  let sum = 0;
  let double = true; // rightmost digit of the body is doubled
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits[i];
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return String((10 - (sum % 10)) % 10);
}

export function isValidIsin(isin: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) return false;
  return isinCheckDigit(isin.slice(0, 11)) === isin[11];
}

/** "ZZ" is not an ISO country code: these ISINs cannot collide with a real security */
function syntheticIsin(n: number): string {
  const body = `ZZDEMO${String(n).padStart(5, "0")}`;
  return body + isinCheckDigit(body);
}

// ---------------------------------------------------------------------------
// Catalogue (all invented)
// ---------------------------------------------------------------------------

const EQUITY_SECTORS: Record<string, number> = {
  Technology: 24.5,
  "Financial Services": 15.2,
  Healthcare: 12.1,
  Industrials: 10.8,
  "Consumer Cyclical": 10.2,
  "Communication Services": 7.4,
  "Consumer Defensive": 6.9,
  Energy: 4.6,
  "Basic Materials": 3.9,
  Utilities: 2.6,
  "Real Estate": 1.8,
};

function catalogue(): SyntheticInstrument[] {
  let n = 0;
  const next = () => syntheticIsin(++n);
  return [
    {
      key: "global-equity",
      isin: next(),
      ticker: null,
      name: "Demo Global Equity Index FI",
      typeId: "FUND",
      exchange: null,
      currency: "EUR",
      fund: {
        category: "RV Global Cap. Grande Blend",
        managementCompany: "Demo Asset Management",
        expenseRatio: 0.0018,
        riskLevel: "4",
        sectorWeights: EQUITY_SECTORS,
        countryAllocation: { US: 62.5, JP: 6.1, GB: 3.8, FR: 2.9, DE: 2.4, CH: 2.3, CA: 2.9, NL: 1.3, AU: 1.9, Other: 13.9 },
        topHoldings: [
          { name: "Demo Semiconductors Corp", ticker: null, weight: 4.6 },
          { name: "Demo Cloud Systems Inc", ticker: null, weight: 4.1 },
          { name: "Demo Retail Platforms", ticker: null, weight: 2.7 },
          { name: "Demo Pharma Holdings", ticker: null, weight: 1.9 },
          { name: "Demo Payments Group", ticker: null, weight: 1.5 },
        ],
      },
      model: { start: 118.4, drift: 0.075, vol: 0.15 },
      dividend: null,
    },
    {
      key: "euro-bonds",
      isin: next(),
      ticker: null,
      name: "Demo Euro Bond Aggregate FI",
      typeId: "FUND",
      exchange: null,
      currency: "EUR",
      fund: {
        category: "RF Diversificada EUR",
        managementCompany: "Demo Asset Management",
        expenseRatio: 0.0025,
        riskLevel: "2",
        sectorWeights: {},
        countryAllocation: { DE: 24.0, FR: 22.5, IT: 16.0, ES: 12.5, NL: 7.0, BE: 4.0, Other: 14.0 },
        topHoldings: [],
      },
      model: { start: 96.2, drift: 0.012, vol: 0.045 },
      dividend: null,
    },
    {
      key: "small-caps",
      isin: next(),
      ticker: null,
      name: "Demo Small Caps Europa FI",
      typeId: "FUND",
      exchange: null,
      currency: "EUR",
      fund: {
        category: "RV Europa Cap. Pequeña",
        managementCompany: "Demo Boutique Gestión SGIIC",
        expenseRatio: 0.0145,
        riskLevel: "5",
        sectorWeights: { Industrials: 26.0, Technology: 18.5, Healthcare: 14.0, "Consumer Cyclical": 13.5, "Financial Services": 9.0, "Basic Materials": 8.0, Other: 11.0 },
        countryAllocation: { DE: 18.0, FR: 16.0, IT: 14.0, ES: 12.0, GB: 11.0, SE: 9.0, NL: 7.0, Other: 13.0 },
        topHoldings: [
          { name: "Demo Robotics SE", ticker: null, weight: 3.8 },
          { name: "Demo Diagnostics SpA", ticker: null, weight: 3.1 },
          { name: "Demo Packaging AB", ticker: null, weight: 2.9 },
        ],
      },
      model: { start: 41.7, drift: 0.06, vol: 0.22 },
      dividend: null,
    },
    {
      key: "money-market",
      isin: next(),
      ticker: null,
      name: "Demo Monetario EUR FI",
      typeId: "FUND",
      exchange: null,
      currency: "EUR",
      fund: {
        category: "Monetario EUR",
        managementCompany: "Demo Asset Management",
        expenseRatio: 0.001,
        riskLevel: "1",
        sectorWeights: {},
        countryAllocation: { FR: 30.0, DE: 25.0, ES: 20.0, NL: 10.0, Other: 15.0 },
        topHoldings: [],
      },
      model: { start: 100.0, drift: 0.022, vol: 0.004 },
      dividend: null,
    },
    {
      key: "us-tracker",
      isin: next(),
      ticker: null,
      name: "Demo US Large Cap UCITS ETF (Acc)",
      typeId: "ETF",
      exchange: "XETR",
      currency: "USD",
      fund: {
        category: "RV USA Cap. Grande Blend",
        managementCompany: "Demo ETF Provider",
        expenseRatio: 0.0007,
        riskLevel: "5",
        sectorWeights: { Technology: 31.0, "Financial Services": 13.0, Healthcare: 11.5, "Consumer Cyclical": 10.5, "Communication Services": 9.0, Industrials: 8.0, "Consumer Defensive": 6.0, Energy: 3.5, Utilities: 2.5, "Basic Materials": 2.0, "Real Estate": 2.0 },
        countryAllocation: { US: 99.2, Other: 0.8 },
        topHoldings: [
          { name: "Demo Semiconductors Corp", ticker: null, weight: 7.1 },
          { name: "Demo Cloud Systems Inc", ticker: null, weight: 6.5 },
          { name: "Demo Retail Platforms", ticker: null, weight: 3.9 },
          { name: "Demo Payments Group", ticker: null, weight: 2.2 },
        ],
      },
      model: { start: 312.0, drift: 0.09, vol: 0.18 },
      dividend: null,
    },
    {
      key: "renewables",
      isin: next(),
      ticker: null,
      name: "Demo Energía Renovable SA",
      typeId: "STOCK",
      exchange: "XMAD",
      currency: "EUR",
      fund: null,
      model: { start: 8.6, drift: 0.045, vol: 0.3 },
      dividend: { yieldAnnual: 0.042, withholdingRate: 0.19, country: "ES" },
    },
    {
      key: "cloud",
      isin: next(),
      ticker: null,
      name: "Demo Cloud Systems Inc",
      typeId: "STOCK",
      exchange: "NASDAQ",
      currency: "USD",
      fund: null,
      model: { start: 58.0, drift: 0.12, vol: 0.36 },
      dividend: { yieldAnnual: 0.008, withholdingRate: 0.15, country: "US" },
    },
    {
      key: "telecom",
      isin: next(),
      ticker: null,
      name: "Demo Telecomunicaciones SA",
      typeId: "STOCK",
      exchange: "XMAD",
      currency: "EUR",
      fund: null,
      model: { start: 4.2, drift: -0.03, vol: 0.26 },
      dividend: { yieldAnnual: 0.065, withholdingRate: 0.19, country: "ES" },
    },
  ];
}

const USERS: SyntheticUser[] = [
  { key: "admin", email: "demo@portfoliohub.example", name: "Demo Admin", role: "ADMIN" },
  { key: "client", email: "cliente@portfoliohub.example", name: "Cliente Demo", role: "CLIENT" },
];

const PORTFOLIOS: SyntheticPortfolio[] = [
  {
    key: "long-term",
    owner: "admin",
    name: "Largo plazo",
    description: "Aportaciones mensuales a fondos indexados, con un traspaso y dos ventas parciales",
    currency: "EUR",
  },
  {
    key: "dividends",
    owner: "admin",
    name: "Dividendos",
    description: "Acciones con dividendo en EUR y USD, retenciones en origen y una venta con pérdida",
    currency: "EUR",
  },
  {
    key: "client",
    owner: "client",
    name: "Cartera conservadora",
    description: "Cartera de un cliente: monetario y renta fija con una pata de renta variable",
    currency: "EUR",
  },
];

// ---------------------------------------------------------------------------
// Series
// ---------------------------------------------------------------------------

function round(x: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

function generatePrices(
  instrument: SyntheticInstrument,
  calendar: string[],
  rand: () => number
): SyntheticPrice[] {
  const { start, drift, vol } = instrument.model;
  const dt = 1 / 252;
  let prev = start;
  const out: SyntheticPrice[] = [];
  for (const date of calendar) {
    const shock = gaussian(rand);
    const close = prev * Math.exp((drift - (vol * vol) / 2) * dt + vol * Math.sqrt(dt) * shock);
    const intraday = Math.abs(gaussian(rand)) * vol * Math.sqrt(dt) * 0.6;
    const open = prev;
    const high = Math.max(open, close) * (1 + intraday);
    const low = Math.min(open, close) * (1 - intraday);
    const decimals = instrument.typeId === "STOCK" ? 3 : 4;
    out.push({
      instrument: instrument.key,
      date,
      open: round(open, decimals),
      high: round(high, decimals),
      low: round(low, decimals),
      close: round(close, decimals),
      volume: instrument.typeId === "FUND" ? 0 : Math.round(200_000 + rand() * 1_800_000),
    });
    prev = close;
  }
  return out;
}

function generateFx(calendar: string[], rand: () => number): SyntheticFxRate[] {
  // EUR/USD around 1.05-1.20: mean-reverting walk, ECB convention (USD per 1 EUR)
  let rate = 1.14;
  const mean = 1.12;
  return calendar.map((date) => {
    rate += (mean - rate) * 0.01 + gaussian(rand) * 0.0035;
    return { date, base: "EUR", quote: "USD", rate: round(rate, 4) };
  });
}

// ---------------------------------------------------------------------------
// Ledger: transactions -> positions, with the application's cost rules
// ---------------------------------------------------------------------------

type Lot = { shares: number; cost: number; costBase: number };

class Ledger {
  readonly transactions: SyntheticTransaction[] = [];
  private readonly holdings = new Map<string, Lot>();

  constructor(
    private readonly closes: Map<string, Map<string, number>>,
    private readonly fx: Map<string, number>,
    private readonly instruments: Map<string, SyntheticInstrument>,
    private readonly calendar: string[]
  ) {}

  private slot(portfolio: string, instrument: string): string {
    return `${portfolio}/${instrument}`;
  }

  /** Close on the first business day on or after `date` (and that day) */
  priceOn(instrument: string, date: string): { date: string; close: number } {
    const day = onOrAfter(this.calendar, date);
    if (!day) throw new Error(`no business day on or after ${date}`);
    const close = this.closes.get(instrument)?.get(day);
    if (close === undefined) throw new Error(`no price for ${instrument} on ${day}`);
    return { date: day, close };
  }

  /** Multiplier from the instrument currency to EUR on that date */
  rateToEur(instrument: string, date: string): number {
    const ins = this.instruments.get(instrument)!;
    if (ins.currency === "EUR") return 1;
    const usdPerEur = this.fx.get(date);
    if (usdPerEur === undefined) throw new Error(`no FX on ${date}`);
    return 1 / usdPerEur;
  }

  sharesHeld(portfolio: string, instrument: string): number {
    return this.holdings.get(this.slot(portfolio, instrument))?.shares ?? 0;
  }

  avgCost(portfolio: string, instrument: string): number {
    const lot = this.holdings.get(this.slot(portfolio, instrument));
    return lot && lot.shares > 0 ? lot.cost / lot.shares : 0;
  }

  avgCostBase(portfolio: string, instrument: string): number {
    const lot = this.holdings.get(this.slot(portfolio, instrument));
    return lot && lot.shares > 0 ? lot.costBase / lot.shares : 0;
  }

  /** Buy for an amount in the instrument currency (funds: 4 decimals; stocks: whole shares) */
  buyAmount(portfolio: string, instrument: string, date: string, amount: number, fees = 0): void {
    const ins = this.instruments.get(instrument)!;
    const { date: day, close } = this.priceOn(instrument, date);
    const raw = (amount - fees) / close;
    const shares = ins.typeId === "FUND" ? round(raw, 4) : Math.max(1, Math.floor(raw));
    this.buyShares(portfolio, instrument, day, shares, close, fees);
  }

  buyShares(portfolio: string, instrument: string, day: string, shares: number, price: number, fees: number): void {
    const cost = round(shares * price + fees, 2);
    const rate = this.rateToEur(instrument, day);
    const lot = this.holdings.get(this.slot(portfolio, instrument)) ?? { shares: 0, cost: 0, costBase: 0 };
    lot.shares = round(lot.shares + shares, 8);
    lot.cost += cost;
    lot.costBase += cost * rate;
    this.holdings.set(this.slot(portfolio, instrument), lot);
    this.transactions.push({
      portfolio,
      instrument,
      type: "BUY",
      date: day,
      shares,
      pricePerShare: price,
      fees,
      totalAmount: cost,
    });
  }

  /** Sell a fraction of the holding (0 < fraction <= 1) */
  sellFraction(portfolio: string, instrument: string, date: string, fraction: number, fees = 0, notes?: string): void {
    const ins = this.instruments.get(instrument)!;
    const held = this.sharesHeld(portfolio, instrument);
    if (held <= 0) throw new Error(`nothing to sell: ${portfolio}/${instrument}`);
    const { date: day, close } = this.priceOn(instrument, date);
    const shares = fraction >= 1 ? held : ins.typeId === "FUND" ? round(held * fraction, 4) : Math.floor(held * fraction);
    if (shares <= 0 || shares > held) throw new Error(`invalid sale: ${shares} of ${held}`);
    const lot = this.holdings.get(this.slot(portfolio, instrument))!;
    const remaining = (lot.shares - shares) / lot.shares;
    lot.shares = round(lot.shares - shares, 8);
    lot.cost *= remaining;
    lot.costBase *= remaining;
    if (lot.shares <= 0) this.holdings.delete(this.slot(portfolio, instrument));
    this.transactions.push({
      portfolio,
      instrument,
      type: "SELL",
      date: day,
      shares,
      pricePerShare: close,
      fees,
      totalAmount: round(shares * close - fees, 2),
      notes,
    });
  }

  /** Fund transfer (traspaso): same shares, fiscal cost dragged, no tax event */
  transfer(portfolio: string, from: string, to: string, date: string, fraction: number, pairKey: string): void {
    const held = this.sharesHeld(portfolio, from);
    if (held <= 0) throw new Error(`nothing to transfer: ${portfolio}/${from}`);
    const day = onOrAfter(this.calendar, date)!;
    const shares = fraction >= 1 ? held : round(held * fraction, 4);
    const fiscalCostDragged = round(this.avgCost(portfolio, from), 4);
    const fiscalCostDraggedBase = round(this.avgCostBase(portfolio, from), 4);
    const totalAmount = round(shares * fiscalCostDragged, 2);

    const origin = this.holdings.get(this.slot(portfolio, from))!;
    const remaining = (origin.shares - shares) / origin.shares;
    origin.shares = round(origin.shares - shares, 8);
    origin.cost *= remaining;
    origin.costBase *= remaining;
    if (origin.shares <= 0) this.holdings.delete(this.slot(portfolio, from));

    const dest = this.holdings.get(this.slot(portfolio, to)) ?? { shares: 0, cost: 0, costBase: 0 };
    dest.shares = round(dest.shares + shares, 8);
    dest.cost += shares * fiscalCostDragged;
    dest.costBase += shares * fiscalCostDraggedBase;
    this.holdings.set(this.slot(portfolio, to), dest);

    this.transactions.push({
      portfolio,
      instrument: from,
      type: "TRANSFER_OUT",
      date: day,
      shares,
      pricePerShare: fiscalCostDragged,
      fees: 0,
      totalAmount,
      transferPair: pairKey,
      fiscalCostDragged,
      notes: "Traspaso entre fondos (exento)",
    });
    this.transactions.push({
      portfolio,
      instrument: to,
      type: "TRANSFER_IN",
      date: day,
      shares,
      pricePerShare: fiscalCostDragged,
      fees: 0,
      totalAmount,
      transferPair: pairKey,
      fiscalCostDragged,
      fiscalCostDraggedBase,
      notes: "Traspaso entre fondos (exento)",
    });
  }

  /** Semi-annual dividend on the shares held, withholding at source */
  dividend(portfolio: string, instrument: string, date: string): void {
    const ins = this.instruments.get(instrument)!;
    const held = this.sharesHeld(portfolio, instrument);
    if (!ins.dividend || held <= 0) return;
    const { date: day, close } = this.priceOn(instrument, date);
    const perShare = round((close * ins.dividend.yieldAnnual) / 2, 4);
    if (perShare <= 0) return;
    const gross = round(held * perShare, 2);
    const withholding = round(gross * ins.dividend.withholdingRate, 2);
    this.transactions.push({
      portfolio,
      instrument,
      type: "DIVIDEND",
      date: day,
      shares: held,
      pricePerShare: perShare,
      fees: 0,
      totalAmount: round(gross - withholding, 2),
      grossAmount: gross,
      withholdingTax: withholding,
      withholdingRate: ins.dividend.withholdingRate,
      withholdingCountry: ins.dividend.country,
    });
  }

  fee(portfolio: string, instrument: string, date: string, amount: number, notes: string): void {
    const day = onOrAfter(this.calendar, date)!;
    this.transactions.push({
      portfolio,
      instrument,
      type: "FEE",
      date: day,
      shares: 0,
      pricePerShare: 0,
      fees: amount,
      totalAmount: -amount,
      notes,
    });
  }

  positions(lastCloses: Map<string, number>): SyntheticPosition[] {
    const out: SyntheticPosition[] = [];
    for (const [slot, lot] of this.holdings) {
      if (lot.shares <= 0) continue;
      const [portfolio, instrument] = slot.split("/");
      out.push({
        portfolio,
        instrument,
        shares: lot.shares,
        avgCost: round(lot.cost / lot.shares, 4),
        avgCostBase: round(lot.costBase / lot.shares, 4),
        currentPrice: lastCloses.get(instrument)!,
      });
    }
    return out.sort((a, b) => a.portfolio.localeCompare(b.portfolio) || a.instrument.localeCompare(b.instrument));
  }
}

// ---------------------------------------------------------------------------
// Snapshots: replay holdings by date (value in EUR at the FX of each date)
// ---------------------------------------------------------------------------

function buildSnapshots(
  portfolios: SyntheticPortfolio[],
  transactions: SyntheticTransaction[],
  closes: Map<string, Map<string, number>>,
  fx: Map<string, number>,
  instruments: Map<string, SyntheticInstrument>,
  dates: string[]
): SyntheticSnapshot[] {
  const out: SyntheticSnapshot[] = [];
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  for (const p of portfolios) {
    const mine = sorted.filter((t) => t.portfolio === p.key);
    let cursor = 0;
    const lots = new Map<string, Lot>();
    for (const date of dates) {
      while (cursor < mine.length && mine[cursor].date <= date) {
        const t = mine[cursor++];
        const lot = lots.get(t.instrument) ?? { shares: 0, cost: 0, costBase: 0 };
        const rate = instruments.get(t.instrument)!.currency === "EUR" ? 1 : 1 / (fx.get(t.date) ?? 1);
        if (t.type === "BUY" || t.type === "TRANSFER_IN") {
          lot.shares = round(lot.shares + t.shares, 8);
          lot.cost += t.totalAmount;
          lot.costBase += t.type === "TRANSFER_IN" && t.fiscalCostDraggedBase != null ? t.shares * t.fiscalCostDraggedBase : t.totalAmount * rate;
        } else if (t.type === "SELL" || t.type === "TRANSFER_OUT") {
          if (lot.shares > 0) {
            const remaining = (lot.shares - t.shares) / lot.shares;
            lot.shares = round(lot.shares - t.shares, 8);
            lot.cost *= remaining;
            lot.costBase *= remaining;
          }
        }
        if (lot.shares <= 0) lots.delete(t.instrument);
        else lots.set(t.instrument, lot);
      }
      if (lots.size === 0) continue;
      let totalValue = 0;
      let totalInvested = 0;
      const byInstrument: Array<{ instrument: string; value: number }> = [];
      for (const [instrument, lot] of lots) {
        const close = closes.get(instrument)!.get(date)!;
        const rate = instruments.get(instrument)!.currency === "EUR" ? 1 : 1 / fx.get(date)!;
        const value = round(lot.shares * close * rate, 2);
        totalValue += value;
        totalInvested += lot.costBase;
        byInstrument.push({ instrument, value });
      }
      out.push({
        portfolio: p.key,
        date,
        totalValue: round(totalValue, 2),
        totalInvested: round(totalInvested, 2),
        byInstrument: byInstrument.sort((a, b) => b.value - a.value),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

function monthsBetween(startMonth: string, endKey: string): string[] {
  // yyyy-mm keys from startMonth (yyyy-mm) to the month of endKey
  const out: string[] = [];
  let [y, m] = startMonth.split("-").map(Number);
  const end = endKey.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > end) break;
    out.push(key);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export function generateSyntheticDataset(options: SyntheticOptions = {}): SyntheticDataset {
  const seed = options.seed ?? 20260101;
  const start = options.start ?? "2021-01-04";
  const end = options.end ?? "2026-10-23";
  if (start >= end) throw new Error("start must be before end");

  const rand = mulberry32(seed);
  const calendar = businessDays(start, end);
  const instruments = catalogue();
  const byKey = new Map(instruments.map((i) => [i.key, i]));

  // Series
  const prices: SyntheticPrice[] = [];
  const closes = new Map<string, Map<string, number>>();
  for (const ins of instruments) {
    const series = generatePrices(ins, calendar, rand);
    prices.push(...series);
    closes.set(ins.key, new Map(series.map((p) => [p.date, p.close])));
  }
  const fxRates = generateFx(calendar, rand);
  const fx = new Map(fxRates.map((r) => [r.date, r.rate]));

  const ledger = new Ledger(closes, fx, byKey, calendar);
  const months = monthsBetween(start.slice(0, 7), end);
  const lastTradeMonth = months[months.length - 2] ?? months[0]; // leave the last month quiet

  // The scenario is declared per portfolio but must run in date order: a
  // sale or a transfer can only touch what was held on that day. Same day:
  // buys (0) before dividends (1) before sales and transfers (2) and fees (3).
  const plan: Array<{ date: string; order: number; run: () => void }> = [];
  const at = (date: string, order: number, run: () => void) => {
    if (date.slice(0, 7) <= lastTradeMonth) plan.push({ date, order, run });
  };

  // Portfolio 1: long term. Monthly contributions from the second month,
  // a fund transfer, a partial sale with a gain and a full exit from bonds.
  for (const [i, month] of months.entries()) {
    if (i === 0) continue;
    const day = `${month}-05`;
    at(day, 0, () => ledger.buyAmount("long-term", "global-equity", day, 300));
    if (i % 2 === 0) at(day, 0, () => ledger.buyAmount("long-term", "euro-bonds", day, 150));
    if (month >= "2022-01" && i % 3 === 0) at(day, 0, () => ledger.buyAmount("long-term", "us-tracker", day, 420, 1.5));
  }
  at("2023-06-14", 2, () => ledger.transfer("long-term", "global-equity", "small-caps", "2023-06-14", 0.25, "traspaso-2023-06"));
  at("2024-03-12", 2, () => ledger.sellFraction("long-term", "global-equity", "2024-03-12", 0.2, 0, "Venta parcial para un gasto"));
  at("2025-10-07", 2, () => ledger.sellFraction("long-term", "euro-bonds", "2025-10-07", 1, 0, "Salida de renta fija"));

  // Portfolio 2: dividends. Stocks bought in tranches, semi-annual dividends,
  // one sale at a loss (loss carry-forward), one broker fee per year.
  const tranches: Array<[string, string, number]> = [
    ["renewables", "2021-02-10", 1500],
    ["renewables", "2021-09-15", 1200],
    ["cloud", "2021-04-20", 2200],
    ["cloud", "2022-06-21", 1800],
    ["telecom", "2021-03-03", 1600],
    ["telecom", "2022-02-08", 900],
    ["renewables", "2023-05-09", 1000],
    ["cloud", "2024-01-16", 1500],
  ];
  for (const [instrument, date, amount] of tranches) {
    at(date, 0, () => ledger.buyAmount("dividends", instrument, date, amount, 4.95));
  }
  at("2022-10-18", 2, () => ledger.sellFraction("dividends", "telecom", "2022-10-18", 1, 4.95, "Venta con pérdida: compensar en IRPF"));
  for (const month of months.filter((m) => m.endsWith("-06") || m.endsWith("-12"))) {
    for (const instrument of ["renewables", "cloud", "telecom"]) {
      at(`${month}-15`, 1, () => ledger.dividend("dividends", instrument, `${month}-15`));
    }
  }
  for (const month of months.filter((m) => m.endsWith("-01") && m > start.slice(0, 7))) {
    at(`${month}-20`, 3, () => ledger.fee("dividends", "renewables", `${month}-20`, 12, "Custodia anual del bróker"));
  }

  // Portfolio 3: a client's conservative portfolio with a partial redemption.
  for (const [i, month] of months.entries()) {
    if (month < "2022-03") continue;
    const day = `${month}-10`;
    at(day, 0, () => ledger.buyAmount("client", "money-market", day, 500));
    at(day, 0, () => ledger.buyAmount("client", "euro-bonds", day, 250));
    if (i % 2 === 1) at(day, 0, () => ledger.buyAmount("client", "global-equity", day, 200));
  }
  at("2025-02-11", 2, () => ledger.sellFraction("client", "money-market", "2025-02-11", 0.3, 0, "Reembolso parcial"));

  plan.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);
  for (const step of plan) step.run();

  const lastCloses = new Map(instruments.map((i) => [i.key, closes.get(i.key)!.get(calendar[calendar.length - 1])!]));
  // Stable order for the writer and the tests: by date, then portfolio, then
  // a type order that keeps the origin leg of a transfer before its destination.
  const TYPE_ORDER: Record<SyntheticTxType, number> = { BUY: 0, DIVIDEND: 1, TRANSFER_OUT: 2, TRANSFER_IN: 3, SELL: 4, FEE: 5 };
  const transactions = [...ledger.transactions].sort(
    (a, b) => a.date.localeCompare(b.date) || a.portfolio.localeCompare(b.portfolio) || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]
  );
  const snapshots = buildSnapshots(PORTFOLIOS, transactions, closes, fx, byKey, lastBusinessDayOfMonth(calendar));

  return {
    meta: { seed, start, end },
    users: USERS,
    portfolios: PORTFOLIOS,
    instruments,
    prices,
    fxRates,
    transactions,
    positions: ledger.positions(lastCloses),
    snapshots,
  };
}
