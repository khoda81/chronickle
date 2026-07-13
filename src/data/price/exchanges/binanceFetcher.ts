/** Range-capable Binance kline adapter for the generic price Fetcher. */

import type { PricePoint } from "../../../domain.ts";
import { Range } from "../../../engine/range.ts";
import type { Fetcher } from "../fetcher.ts";
import { pickResolution } from "../resolution.ts";

const BINANCE_KLINES = "https://api.binance.com/api/v3/klines";
const LIMIT = 1_000;

const BINANCE_LADDER: readonly { readonly periodMs: number; readonly interval: string }[] = [
  { periodMs: 60_000, interval: "1m" },
  { periodMs: 3 * 60_000, interval: "3m" },
  { periodMs: 5 * 60_000, interval: "5m" },
  { periodMs: 15 * 60_000, interval: "15m" },
  { periodMs: 30 * 60_000, interval: "30m" },
  { periodMs: 60 * 60_000, interval: "1h" },
  { periodMs: 2 * 60 * 60_000, interval: "2h" },
  { periodMs: 4 * 60 * 60_000, interval: "4h" },
  { periodMs: 6 * 60 * 60_000, interval: "6h" },
  { periodMs: 8 * 60 * 60_000, interval: "8h" },
  { periodMs: 12 * 60 * 60_000, interval: "12h" },
  { periodMs: 24 * 60 * 60_000, interval: "1d" },
  { periodMs: 3 * 24 * 60 * 60_000, interval: "3d" },
  { periodMs: 7 * 24 * 60 * 60_000, interval: "1w" },
];

const PERIODS = BINANCE_LADDER.map((entry) => entry.periodMs);

export interface BinanceFetcherOptions {
  readonly symbol: string;
  readonly timeoutMs?: number;
}

export function createBinanceFetcher(opts: BinanceFetcherOptions): Fetcher {
  const symbol = opts.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,30}$/.test(symbol)) {
    throw new Error(`Invalid Binance symbol: ${opts.symbol}`);
  }

  return {
    retryDelayMs(error, attempt) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("429") || message.includes("418")) return 60_000;
      return Math.min(30_000, 1_000 * 2 ** (attempt - 1));
    },

    async fetchRange({ range, maxDeltaTMs }) {
      const periodMs = pickResolution(PERIODS, maxDeltaTMs);
      const entry = BINANCE_LADDER.find((candidate) => candidate.periodMs === periodMs)!;
      const params = new URLSearchParams({
        symbol,
        interval: entry.interval,
        startTime: Math.floor(range.min - periodMs).toString(),
        endTime: Math.floor(range.max).toString(),
        limit: LIMIT.toString(),
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);

      try {
        const response = await fetch(`${BINANCE_KLINES}?${params}`, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Binance klines failed: ${response.status} ${response.statusText}`);
        }
        const raw: unknown = await response.json();
        if (!Array.isArray(raw)) throw new Error("Binance klines returned a non-array payload");

        const points: PricePoint[] = [];
        for (const row of raw) {
          if (!Array.isArray(row)) continue;
          const t = Number(row[0]);
          const price = Number(row[1]);
          if (Number.isFinite(t) && Number.isFinite(price) && price > 0) points.push({ t, price });
        }

        let searchedRange = range;
        const last = points[points.length - 1];
        if (raw.length >= LIMIT && last !== undefined) {
          const searchedMax = Math.min(range.max, last.t + periodMs);
          if (range.min < searchedMax) searchedRange = Range.create(range.min, searchedMax);
        }
        return { points, resolutionHintMs: periodMs, searchedRange };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
