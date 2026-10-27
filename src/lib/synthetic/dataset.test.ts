/**
 * Tests of the synthetic dataset generator.
 *
 * The generator is what the demo database, the README screenshots and any
 * fixture-hungry test rely on, so these tests pin down what makes it usable:
 * determinism, internal consistency (no sale beyond the holding, transfer
 * pairs that balance, positions that match a replay of the transactions),
 * and the absence of anything that could be mistaken for a real security.
 */

import { describe, it, expect } from "vitest";
import {
  businessDays,
  generateSyntheticDataset,
  isValidIsin,
  isinCheckDigit,
  mulberry32,
  type SyntheticDataset,
} from "@/lib/synthetic/dataset";

const dataset = generateSyntheticDataset({ seed: 42, start: "2021-01-04", end: "2026-10-23" });

function replayShares(ds: SyntheticDataset, portfolio: string, instrument: string): number {
  let shares = 0;
  for (const t of ds.transactions) {
    if (t.portfolio !== portfolio || t.instrument !== instrument) continue;
    if (t.type === "BUY" || t.type === "TRANSFER_IN") shares += t.shares;
    if (t.type === "SELL" || t.type === "TRANSFER_OUT") shares -= t.shares;
  }
  return Math.round(shares * 1e8) / 1e8;
}

describe("mulberry32 and ISIN helpers", () => {
  it("is deterministic and uniform in [0, 1)", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    const xs = Array.from({ length: 1000 }, () => a());
    const ys = Array.from({ length: 1000 }, () => b());
    expect(xs).toEqual(ys);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });

  it("computes the ISIN check digit of well-known securities", () => {
    // Public, widely documented examples of the ISIN algorithm
    expect(isinCheckDigit("US037833100")).toBe("5"); // Apple
    expect(isinCheckDigit("ES0113900J3")).toBe("7"); // Banco Santander
    expect(isinCheckDigit("IE00B4L5Y98")).toBe("3"); // iShares Core MSCI World
    expect(isValidIsin("US0378331005")).toBe(true);
    expect(isValidIsin("US0378331006")).toBe(false);
  });

  it("lists Monday to Friday only", () => {
    const days = businessDays("2026-10-19", "2026-10-25"); // Mon .. Sun
    expect(days).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]);
  });
});

describe("generateSyntheticDataset", () => {
  it("is deterministic for the same seed and differs for another seed", () => {
    const again = generateSyntheticDataset({ seed: 42, start: "2021-01-04", end: "2026-10-23" });
    expect(again).toEqual(dataset);
    const other = generateSyntheticDataset({ seed: 43, start: "2021-01-04", end: "2026-10-23" });
    expect(other.prices[other.prices.length - 1].close).not.toBe(dataset.prices[dataset.prices.length - 1].close);
  });

  it("uses only fictitious instruments with a valid check digit and a non-ISO prefix", () => {
    expect(dataset.instruments.length).toBeGreaterThanOrEqual(6);
    const isins = new Set<string>();
    for (const ins of dataset.instruments) {
      expect(ins.isin.startsWith("ZZ")).toBe(true);
      expect(isValidIsin(ins.isin)).toBe(true);
      expect(ins.name).toMatch(/^Demo /);
      isins.add(ins.isin);
    }
    expect(isins.size).toBe(dataset.instruments.length);
    for (const u of dataset.users) expect(u.email.endsWith("@portfoliohub.example")).toBe(true);
  });

  it("produces a positive daily price for every instrument and business day", () => {
    const calendar = businessDays(dataset.meta.start, dataset.meta.end);
    expect(dataset.prices.length).toBe(calendar.length * dataset.instruments.length);
    for (const p of dataset.prices) {
      expect(p.close).toBeGreaterThan(0);
      expect(p.low).toBeLessThanOrEqual(Math.min(p.open, p.close));
      expect(p.high).toBeGreaterThanOrEqual(Math.max(p.open, p.close));
    }
    // enough history for the 5-year charts and the 252-day risk window
    expect(calendar.length).toBeGreaterThan(1300);
  });

  it("publishes an EUR/USD rate for every business day in the ECB convention", () => {
    const calendar = businessDays(dataset.meta.start, dataset.meta.end);
    expect(dataset.fxRates.length).toBe(calendar.length);
    for (const r of dataset.fxRates) {
      expect(r.base).toBe("EUR");
      expect(r.quote).toBe("USD");
      expect(r.rate).toBeGreaterThan(0.9);
      expect(r.rate).toBeLessThan(1.4);
    }
  });

  it("never sells or transfers more than the holding, in chronological order", () => {
    const held = new Map<string, number>();
    const sorted = [...dataset.transactions].sort((a, b) => a.date.localeCompare(b.date));
    for (const t of sorted) {
      const slot = `${t.portfolio}/${t.instrument}`;
      const before = held.get(slot) ?? 0;
      if (t.type === "BUY" || t.type === "TRANSFER_IN") held.set(slot, before + t.shares);
      if (t.type === "SELL" || t.type === "TRANSFER_OUT") {
        expect(t.shares).toBeLessThanOrEqual(before + 1e-6);
        held.set(slot, before - t.shares);
      }
      if (t.type === "DIVIDEND") expect(before).toBeGreaterThan(0);
    }
  });

  it("prices every trade at the close of its trade date", () => {
    const closes = new Map(dataset.prices.map((p) => [`${p.instrument}@${p.date}`, p.close]));
    for (const t of dataset.transactions) {
      if (t.type !== "BUY" && t.type !== "SELL") continue;
      expect(t.pricePerShare).toBe(closes.get(`${t.instrument}@${t.date}`));
      const expected = t.type === "BUY" ? t.shares * t.pricePerShare + t.fees : t.shares * t.pricePerShare - t.fees;
      expect(Math.abs(t.totalAmount - expected)).toBeLessThan(0.011);
    }
  });

  it("writes fund transfers as balanced pairs at the dragged fiscal cost", () => {
    const pairs = new Map<string, typeof dataset.transactions>();
    for (const t of dataset.transactions) {
      if (!t.transferPair) continue;
      pairs.set(t.transferPair, [...(pairs.get(t.transferPair) ?? []), t]);
    }
    expect(pairs.size).toBeGreaterThanOrEqual(1);
    for (const legs of pairs.values()) {
      expect(legs).toHaveLength(2);
      const out = legs.find((l) => l.type === "TRANSFER_OUT")!;
      const inn = legs.find((l) => l.type === "TRANSFER_IN")!;
      expect(out.shares).toBe(inn.shares);
      expect(out.pricePerShare).toBe(inn.pricePerShare);
      expect(out.fiscalCostDragged).toBe(inn.fiscalCostDragged);
      expect(inn.fiscalCostDraggedBase).toBeDefined();
      expect(out.fees).toBe(0);
      expect(out.date).toBe(inn.date);
    }
  });

  it("records dividends with gross, withholding and net consistent", () => {
    const dividends = dataset.transactions.filter((t) => t.type === "DIVIDEND");
    expect(dividends.length).toBeGreaterThan(10);
    const countries = new Set(dividends.map((d) => d.withholdingCountry));
    expect(countries.has("ES")).toBe(true);
    expect(countries.has("US")).toBe(true);
    for (const d of dividends) {
      expect(d.grossAmount).toBeGreaterThan(0);
      expect(Math.abs(d.withholdingTax! - d.grossAmount! * d.withholdingRate!)).toBeLessThan(0.011);
      // As the app's API stores it: totalAmount = shares x gross per share
      expect(d.totalAmount).toBe(d.grossAmount);
      expect(Math.abs(d.totalAmount - d.shares * d.pricePerShare)).toBeLessThan(0.011);
    }
  });

  it("never puts an inflow and an outflow of the same holding on the same day", () => {
    // The app replays by tradeDate only (a @db.Date column), so same-day order
    // is undefined there; the generator must not rely on its in-memory order.
    const seen = new Map<string, Set<string>>();
    for (const t of dataset.transactions) {
      const key = `${t.date}/${t.portfolio}/${t.instrument}`;
      const kinds = seen.get(key) ?? new Set<string>();
      if (t.type === "BUY" || t.type === "TRANSFER_IN") kinds.add("in");
      if (t.type === "SELL" || t.type === "TRANSFER_OUT") kinds.add("out");
      seen.set(key, kinds);
      expect(kinds.size, key).toBeLessThan(2);
    }
  });

  it("agrees between the two replays: last snapshot invested = positions' shares x avgCostBase", () => {
    const lastDate = dataset.prices[dataset.prices.length - 1].date;
    for (const p of dataset.portfolios) {
      const last = dataset.snapshots.filter((s) => s.portfolio === p.key).at(-1)!;
      expect(last.date).toBe(lastDate);
      const invested = dataset.positions
        .filter((pos) => pos.portfolio === p.key)
        .reduce((acc, pos) => acc + pos.shares * pos.avgCostBase, 0);
      expect(Math.abs(last.totalInvested - invested)).toBeLessThan(0.5);
      const value = dataset.positions
        .filter((pos) => pos.portfolio === p.key)
        .reduce((acc, pos) => acc + pos.shares * pos.currentPrice * (dataset.instruments.find((i) => i.key === pos.instrument)!.currency === "EUR" ? 1 : 1 / dataset.fxRates.at(-1)!.rate), 0);
      expect(Math.abs(last.totalValue - value)).toBeLessThan(0.5);
    }
  });

  it("derives positions that match a replay of the transactions", () => {
    expect(dataset.positions.length).toBeGreaterThanOrEqual(6);
    const lastDate = dataset.prices[dataset.prices.length - 1].date;
    const lastClose = new Map(dataset.prices.filter((p) => p.date === lastDate).map((p) => [p.instrument, p.close]));
    for (const pos of dataset.positions) {
      expect(pos.shares).toBeCloseTo(replayShares(dataset, pos.portfolio, pos.instrument), 6);
      expect(pos.avgCost).toBeGreaterThan(0);
      expect(pos.avgCostBase).toBeGreaterThan(0);
      expect(pos.currentPrice).toBe(lastClose.get(pos.instrument));
    }
    // every portfolio/instrument with a live holding has exactly one position
    const slots = new Set(dataset.positions.map((p) => `${p.portfolio}/${p.instrument}`));
    expect(slots.size).toBe(dataset.positions.length);
    for (const p of dataset.portfolios) {
      for (const ins of dataset.instruments) {
        const shares = replayShares(dataset, p.key, ins.key);
        expect(slots.has(`${p.key}/${ins.key}`)).toBe(shares > 1e-8);
      }
    }
  });

  it("covers the fiscal scenarios the engines show off: a loss, a gain, a transfer", () => {
    const sells = dataset.transactions.filter((t) => t.type === "SELL");
    expect(sells.length).toBeGreaterThanOrEqual(3);
    expect(sells.some((s) => s.notes?.includes("pérdida"))).toBe(true);
    expect(dataset.transactions.some((t) => t.type === "FEE")).toBe(true);
    expect(dataset.transactions.some((t) => t.type === "TRANSFER_IN")).toBe(true);
  });

  it("builds one snapshot per portfolio and month-end once the portfolio has holdings", () => {
    expect(dataset.snapshots.length).toBeGreaterThan(100);
    for (const s of dataset.snapshots) {
      expect(s.totalValue).toBeGreaterThan(0);
      expect(s.totalInvested).toBeGreaterThan(0);
      const sum = s.byInstrument.reduce((acc, b) => acc + b.value, 0);
      expect(Math.abs(sum - s.totalValue)).toBeLessThan(0.05);
    }
    const perPortfolio = new Map<string, string[]>();
    for (const s of dataset.snapshots) perPortfolio.set(s.portfolio, [...(perPortfolio.get(s.portfolio) ?? []), s.date]);
    for (const dates of perPortfolio.values()) {
      expect(new Set(dates).size).toBe(dates.length);
      expect([...dates].sort()).toEqual(dates);
    }
  });
});
