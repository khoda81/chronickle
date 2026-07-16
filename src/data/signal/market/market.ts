import type { SignalAdapter } from "../fetcher.ts";
import { createBinanceAdapter } from "./adapters/binanceFetcher.ts";
import { createNobitexAdapter } from "./adapters/nobitexFetcher.ts";
import { createYahooAdapter } from "./adapters/yahoo.ts";
import { fetchBinanceSymbols, fetchNobitexSymbols, type MarketSymbol } from "./symbols.ts";

export type PriceSignalSourceId = "nobitex" | "binance" | "yahoo";

/** UI-facing description of a market that produces a log-price signal. */
export interface PriceSignalSource {
  readonly id: PriceSignalSourceId;
  readonly label: string;
  readonly examples: readonly MarketSymbol[];
  normalizeSymbol(value: string): string;
  createAdapter(symbol: string): SignalAdapter;
  loadSymbols(): Promise<readonly MarketSymbol[]>;
}

function normalizeSymbol(value: string): string {
  const symbol = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (symbol.length < 4 || symbol.length > 30) throw new Error(`Invalid market symbol: ${value}`);
  return symbol;
}

function normalizeYahooSymbol(value: string): string {
  const symbol = value.trim().toUpperCase();
  if (!/^[A-Z0-9.^=_-]{1,40}$/.test(symbol)) {
    throw new Error(`Invalid Yahoo Finance symbol: ${value}`);
  }
  return symbol;
}

const NOBITEX_EXAMPLES: readonly MarketSymbol[] = [
  { symbol: "USDTIRT", label: "USDT / IRT" },
  { symbol: "BTCIRT", label: "BTC / IRT" },
  { symbol: "ETHIRT", label: "ETH / IRT" },
  { symbol: "BTCUSDT", label: "BTC / USDT" },
  { symbol: "ETHUSDT", label: "ETH / USDT" },
];

const BINANCE_EXAMPLES: readonly MarketSymbol[] = [
  { symbol: "BTCUSDT", label: "BTC / USDT" },
  { symbol: "ETHUSDT", label: "ETH / USDT" },
  { symbol: "PAXGUSDT", label: "PAXG / USDT" },
  { symbol: "SOLUSDT", label: "SOL / USDT" },
  { symbol: "BNBUSDT", label: "BNB / USDT" },
];

const YAHOO_EXAMPLES: readonly MarketSymbol[] = [
  { symbol: "CL=F", label: "WTI crude oil futures" },
  { symbol: "BZ=F", label: "Brent crude oil futures" },
  { symbol: "NG=F", label: "Natural gas futures" },
  { symbol: "GC=F", label: "Gold futures" },
  { symbol: "^GSPC", label: "S&P 500 index" },
];

let nobitexSymbols: Promise<readonly MarketSymbol[]> | null = null;
let binanceSymbols: Promise<readonly MarketSymbol[]> | null = null;

function loadNobitexSymbols(): Promise<readonly MarketSymbol[]> {
  nobitexSymbols ??= fetchNobitexSymbols().catch(error => {
    nobitexSymbols = null;
    throw error;
  });
  return nobitexSymbols;
}

function loadBinanceSymbols(): Promise<readonly MarketSymbol[]> {
  binanceSymbols ??= fetchBinanceSymbols().catch(error => {
    binanceSymbols = null;
    throw error;
  });
  return binanceSymbols;
}

export const PRICE_SIGNAL_SOURCES: readonly PriceSignalSource[] = [
  {
    id: "nobitex",
    label: "Nobitex",
    examples: NOBITEX_EXAMPLES,
    normalizeSymbol,
    createAdapter: symbol => createNobitexAdapter({ symbol }),
    loadSymbols: loadNobitexSymbols,
  },
  {
    id: "binance",
    label: "Binance",
    examples: BINANCE_EXAMPLES,
    normalizeSymbol,
    createAdapter: symbol => createBinanceAdapter({ symbol }),
    loadSymbols: loadBinanceSymbols,
  },
  {
    id: "yahoo",
    label: "Yahoo Finance",
    examples: YAHOO_EXAMPLES,
    normalizeSymbol: normalizeYahooSymbol,
    createAdapter: symbol => createYahooAdapter({ symbol }),
    loadSymbols: async () => YAHOO_EXAMPLES,
  },
];

export function priceSignalSource(id: string): PriceSignalSource | null {
  return PRICE_SIGNAL_SOURCES.find(source => source.id === id) ?? null;
}
