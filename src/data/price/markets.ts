import type { Fetcher } from "./fetcher.ts";
import { createBinanceFetcher } from "./exchanges/binanceFetcher.ts";
import { createNobitexFetcher } from "./exchanges/nobitexFetcher.ts";
import { createYahooFetcher } from "./exchanges/yahoo.ts";
import { fetchBinanceSymbols, fetchNobitexSymbols, type MarketSymbol } from "./symbols.ts";

export type MarketSourceId = "nobitex" | "binance" | "yahoo";

export interface MarketSource {
  readonly id: MarketSourceId;
  readonly label: string;
  readonly examples: readonly MarketSymbol[];
  normalizeSymbol(value: string): string;
  createFetcher(symbol: string): Fetcher;
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
  nobitexSymbols ??= fetchNobitexSymbols().catch((error) => {
    nobitexSymbols = null;
    throw error;
  });
  return nobitexSymbols;
}

function loadBinanceSymbols(): Promise<readonly MarketSymbol[]> {
  binanceSymbols ??= fetchBinanceSymbols().catch((error) => {
    binanceSymbols = null;
    throw error;
  });
  return binanceSymbols;
}

export const MARKET_SOURCES: readonly MarketSource[] = [
  {
    id: "nobitex",
    label: "Nobitex",
    examples: NOBITEX_EXAMPLES,
    normalizeSymbol,
    createFetcher: (symbol) => createNobitexFetcher({ symbol }),
    loadSymbols: loadNobitexSymbols,
  },
  {
    id: "binance",
    label: "Binance",
    examples: BINANCE_EXAMPLES,
    normalizeSymbol,
    createFetcher: (symbol) => createBinanceFetcher({ symbol }),
    loadSymbols: loadBinanceSymbols,
  },
  {
    id: "yahoo",
    label: "Yahoo Finance",
    examples: YAHOO_EXAMPLES,
    normalizeSymbol: normalizeYahooSymbol,
    createFetcher: (symbol) => createYahooFetcher({ symbol }),
    loadSymbols: async () => YAHOO_EXAMPLES,
  },
];

export function marketSource(id: string): MarketSource | null {
  return MARKET_SOURCES.find((source) => source.id === id) ?? null;
}
