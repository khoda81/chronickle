/** Interval-aware Yahoo Finance chart adapter for futures, equities, and indices. */

import type { Sample } from "../../sample.ts";
import {
  createPollingSignalSource,
  demandSampleSpacingMs,
  type AdapterBatch,
  type SignalAdapter,
} from "../../fetcher.ts";
import { logPriceSamples, type PricePoint } from "../price.ts";

const YAHOO_CHART_API = "https://query2.finance.yahoo.com/v8/finance/chart";
const CORS_PROXY = "https://corsproxy.io/?url=";
const DAY_MS = 86_400_000;
const MAX_CACHE_ENTRIES = 32;

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

export interface YahooAdapterOptions {
  readonly symbol: string;
  readonly timeoutMs?: number;
  readonly proxy?: string;
  readonly now?: () => number;
}

export function createYahooAdapter(opts: YahooAdapterOptions): SignalAdapter {
  const symbol = opts.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.^=_-]{1,40}$/.test(symbol)) {
    throw new Error(`Invalid Yahoo Finance symbol: ${opts.symbol}`);
  }
  const now = opts.now ?? Date.now;
  const cache = new Map<string, CachedYahooResult>();
  const pending = new Map<string, Promise<CachedYahooResult>>();
  let generation = 0;

  return createPollingSignalSource({
    minFetchPoints: 128,
    sourceWideBackoff: true,
    now,

    retryDelayMs(error, attempt) {
      if (error instanceof YahooHttpError && error.status === 429) {
        return error.retryAfterMs ?? Math.min(15 * 60_000, 60_000 * 2 ** (attempt - 1));
      }
      return Math.min(60_000, 2_000 * 2 ** (attempt - 1));
    },

    clearCache() {
      generation++;
      cache.clear();
      pending.clear();
    },

    resolve(demand) {
      return chooseInterval(demandSampleSpacingMs(demand), demand.range.start, now()).periodMs;
    },

    async fetchInterval({ range, resolutionMs }, signal) {
      const entry = YAHOO_LADDER.find(candidate => candidate.periodMs === resolutionMs);
      if (entry === undefined) throw new Error(`Yahoo: unsupported resolution ${resolutionMs}`);
      const startMs = Math.floor((range.start - entry.periodMs) / entry.periodMs) * entry.periodMs;
      const roundedEndMs = Math.ceil(range.end / entry.periodMs) * entry.periodMs;
      const endMs = Math.max(startMs + entry.periodMs, roundedEndMs);
      const key = `${entry.interval}:${startMs}:${endMs}`;
      const requestGeneration = generation;

      const cached = cache.get(key);
      if (cached !== undefined) return withSearchedInterval(cached, range);

      let work = pending.get(key);
      if (work === undefined) {
        work = fetchYahooWindow(symbol, entry, startMs, endMs, opts, signal);
        pending.set(key, work);
      }

      try {
        const result = await work;
        if (requestGeneration === generation) {
          cache.set(key, result);
          trimOldest(cache, MAX_CACHE_ENTRIES);
        }
        return withSearchedInterval(result, range);
      } finally {
        if (pending.get(key) === work) pending.delete(key);
      }
    },
  });
}

async function fetchYahooWindow(
  symbol: string,
  entry: YahooInterval,
  startMs: number,
  endMs: number,
  opts: YahooAdapterOptions,
  signal: AbortSignal,
): Promise<CachedYahooResult> {
  const params = new URLSearchParams({
    period1: Math.floor(startMs / 1_000).toString(),
    period2: Math.ceil(endMs / 1_000).toString(),
    interval: entry.interval,
    events: "history",
    includeAdjustedClose: "false",
  });
  const target = `${YAHOO_CHART_API}/${encodeURIComponent(symbol)}?${params}`;
  const url = `${opts.proxy ?? CORS_PROXY}${encodeURIComponent(target)}`;
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(opts.timeoutMs ?? 15_000)]),
  });
  if (!response.ok) {
    throw new YahooHttpError(
      `Yahoo Finance chart failed: ${response.status} ${response.statusText}`,
      response.status,
      retryAfterMs(response.headers.get("retry-after")),
    );
  }
  const payload = (await response.json()) as YahooChartResponse;
  if (payload.chart?.error !== null && payload.chart?.error !== undefined) {
    const detail = payload.chart.error.description ?? payload.chart.error.code ?? "unknown error";
    const rateLimited = /rate|too many/i.test(detail);
    throw new YahooHttpError(
      `Yahoo Finance chart failed: ${detail}`,
      rateLimited ? 429 : 500,
      null,
    );
  }
  const result = payload.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const opens = result?.indicators?.quote?.[0]?.open;
  if (!Array.isArray(timestamps) || !Array.isArray(opens)) {
    throw new Error("Yahoo Finance chart returned no timestamp/open arrays");
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
  return { samples: logPriceSamples(points) };
}

interface CachedYahooResult {
  readonly samples: readonly Sample[];
}

class YahooHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = "YahooHttpError";
  }
}

function withSearchedInterval(
  result: CachedYahooResult,
  searchedInterval: AdapterBatch["searchedInterval"],
): AdapterBatch {
  return { ...result, searchedInterval };
}

function retryAfterMs(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function trimOldest<K, V>(map: Map<K, V>, maxSize: number): void {
  while (map.size > maxSize) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
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
  const eligible = YAHOO_LADDER.filter(candidate => now - rangeMin <= candidate.lookbackMs);
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
