/** Range-aware Yahoo Finance chart adapter for futures, equities, and indices. */

import type { PricePoint } from "../../../domain.ts";
import type { Fetcher } from "../fetcher.ts";

const YAHOO_CHART_API = "https://query2.finance.yahoo.com/v8/finance/chart";
const CORS_PROXY = "https://corsproxy.io/?url=";
const DAY_MS = 86_400_000;

interface YahooInterval {
  readonly periodMs: number;
  readonly interval: string;
  /** Maximum historical age supported by Yahoo for this interval. */
  readonly lookbackMs: number;
}

const YAHOO_LADDER: readonly YahooInterval[] = [
  { periodMs: 60_000, interval: "1m", lookbackMs: 8 * DAY_MS },
  { periodMs: 2 * 60_000, interval: "2m", lookbackMs: 60 * DAY_MS },
  { periodMs: 5 * 60_000, interval: "5m", lookbackMs: 60 * DAY_MS },
  { periodMs: 15 * 60_000, interval: "15m", lookbackMs: 60 * DAY_MS },
  { periodMs: 30 * 60_000, interval: "30m", lookbackMs: 60 * DAY_MS },
  { periodMs: 60 * 60_000, interval: "60m", lookbackMs: 730 * DAY_MS },
  { periodMs: DAY_MS, interval: "1d", lookbackMs: Number.POSITIVE_INFINITY },
  { periodMs: 7 * DAY_MS, interval: "1wk", lookbackMs: Number.POSITIVE_INFINITY },
];

export interface YahooFetcherOptions {
  readonly symbol: string;
  readonly timeoutMs?: number;
  readonly proxy?: string;
  readonly now?: () => number;
}

export function createYahooFetcher(opts: YahooFetcherOptions): Fetcher {
  const symbol = opts.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.^=_-]{1,40}$/.test(symbol)) {
    throw new Error(`Invalid Yahoo Finance symbol: ${opts.symbol}`);
  }
  const now = opts.now ?? Date.now;

  return {
    retryDelayMs(_error, attempt) {
      return Math.min(60_000, 2_000 * 2 ** (attempt - 1));
    },

    async fetchRange({ range, maxDeltaTMs }) {
      const entry = chooseInterval(maxDeltaTMs, range.min, now());

      const params = new URLSearchParams({
        period1: Math.floor((range.min - entry.periodMs) / 1_000).toString(),
        period2: Math.ceil(range.max / 1_000).toString(),
        interval: entry.interval,
        events: "history",
        includeAdjustedClose: "false",
      });
      const target = `${YAHOO_CHART_API}/${encodeURIComponent(symbol)}?${params}`;
      const url = `${opts.proxy ?? CORS_PROXY}${encodeURIComponent(target)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);

      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Yahoo Finance chart failed: ${response.status} ${response.statusText}`);
        }
        const payload = (await response.json()) as YahooChartResponse;
        if (payload.chart?.error !== null && payload.chart?.error !== undefined) {
          throw new Error(
            `Yahoo Finance chart failed: ${payload.chart.error.description ?? payload.chart.error.code}`,
          );
        }
        const result = payload.chart?.result?.[0];
        const timestamps = result?.timestamp;
        const opens = result?.indicators?.quote?.[0]?.open;
        if (!Array.isArray(timestamps) || !Array.isArray(opens)) {
          return { points: [], resolutionHintMs: entry.periodMs, searchedRange: range };
        }

        const points: PricePoint[] = [];
        const count = Math.min(timestamps.length, opens.length);
        for (let index = 0; index < count; index++) {
          const seconds = timestamps[index];
          const price = opens[index];
          if (
            typeof seconds === "number" &&
            typeof price === "number" &&
            Number.isFinite(seconds) &&
            Number.isFinite(price) &&
            price > 0
          ) {
            points.push({ t: seconds * 1_000, price });
          }
        }
        return { points, resolutionHintMs: entry.periodMs, searchedRange: range };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function chooseYahooInterval(
  maxDeltaTMs: number,
  rangeMin: number,
  now: number,
): { readonly periodMs: number; readonly interval: string } {
  const entry = chooseInterval(maxDeltaTMs, rangeMin, now);
  return { periodMs: entry.periodMs, interval: entry.interval };
}

function chooseInterval(maxDeltaTMs: number, rangeMin: number, now: number): YahooInterval {
  const eligible = YAHOO_LADDER.filter((candidate) => now - rangeMin <= candidate.lookbackMs);
  // Daily and weekly history have no lookback limit, so this is structurally
  // non-empty. Start with the finest available interval as the best effort
  // when even it is coarser than the viewport asks for.
  let selected = eligible[0]!;
  for (const candidate of eligible) {
    if (candidate.periodMs > maxDeltaTMs) break;
    selected = candidate;
  }
  return selected;
}

interface YahooChartResponse {
  readonly chart?: {
    readonly result?:
      | readonly {
          readonly timestamp?: readonly number[];
          readonly indicators?: {
            readonly quote?: readonly { readonly open?: readonly (number | null)[] }[];
          };
        }[]
      | null;
    readonly error?: { readonly code?: string; readonly description?: string } | null;
  };
}
