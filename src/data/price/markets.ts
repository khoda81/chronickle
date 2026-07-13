import type { Fetcher } from "./fetcher.ts";
import { createBinanceFetcher } from "./exchanges/binanceFetcher.ts";
import { createNobitexFetcher } from "./exchanges/nobitexFetcher.ts";

export type MarketSourceId = "nobitex" | "binance";

export interface MarketSource {
  readonly id: MarketSourceId;
  readonly label: string;
  readonly examples: readonly string[];
  normalizeSymbol(value: string): string;
  createFetcher(symbol: string): Fetcher;
}

function normalizeSymbol(value: string): string {
  const symbol = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (symbol.length < 4 || symbol.length > 30) throw new Error(`Invalid market symbol: ${value}`);
  return symbol;
}

export const MARKET_SOURCES: readonly MarketSource[] = [
  {
    id: "nobitex",
    label: "Nobitex",
    examples: ["USDTIRT", "BTCIRT", "ETHIRT", "BTCUSDT", "ETHUSDT"],
    normalizeSymbol,
    createFetcher: (symbol) => createNobitexFetcher({ symbol }),
  },
  {
    id: "binance",
    label: "Binance",
    examples: ["BTCUSDT", "ETHUSDT", "PAXGUSDT", "SOLUSDT", "BNBUSDT"],
    normalizeSymbol,
    createFetcher: (symbol) => createBinanceFetcher({ symbol }),
  },
];

export function marketSource(id: string): MarketSource | null {
  return MARKET_SOURCES.find((source) => source.id === id) ?? null;
}
