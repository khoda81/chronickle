/**
 * Nobitex adapter for the `Fetcher` contract.
 *
 * Wraps the existing `fetchOhlc` and maps the broker's `maxDeltaTMs` to the
 * coarsest Nobitex TradingView resolution whose period is `<= maxDeltaTMs`.
 * Nobitex OHLC returns timestamps in epoch **seconds**; this adapter
 * converts to milliseconds at the boundary so the rest of the data layer
 * only ever sees ms.
 *
 * Nobitex resolution table (period in seconds):
 *   60 ("1"), 300 ("5"), 900 ("15"), 1800 ("30"),
 *   3600 ("60"), 10800 ("180"), 14400 ("240"), 21600 ("360"),
 *   43200 ("720"), 86400 ("D"), 172800 ("2D"), 259200 ("3D")
 */

import { Fetcher, FetchRangeOptions } from "./fetcher.ts";
import { pickResolution } from "./resolution.ts";
import { fetchOhlc, NobitexOhlcResponse, ohlcToPriceSeries } from "./nobitex.ts";
import { PricePoint } from "../domain.ts";

const MS = 1000;

/** Nobitex native sample periods in ms, finest→coarsest, with their TradingView strings. */
const NOBITEX_LADDER: readonly { periodMs: number; resolution: string }[] = [
  { periodMs: 60 * MS, resolution: "1" },
  { periodMs: 5 * 60 * MS, resolution: "5" },
  { periodMs: 15 * 60 * MS, resolution: "15" },
  { periodMs: 30 * 60 * MS, resolution: "30" },
  { periodMs: 60 * 60 * MS, resolution: "60" },
  { periodMs: 3 * 60 * 60 * MS, resolution: "180" },
  { periodMs: 4 * 60 * 60 * MS, resolution: "240" },
  { periodMs: 6 * 60 * 60 * MS, resolution: "360" },
  { periodMs: 12 * 60 * 60 * MS, resolution: "720" },
  { periodMs: 24 * 60 * 60 * MS, resolution: "D" },
  { periodMs: 2 * 24 * 60 * 60 * MS, resolution: "2D" },
  { periodMs: 3 * 24 * 60 * 60 * MS, resolution: "3D" },
];

const NOBITEX_PERIODS_MS: readonly number[] = NOBITEX_LADDER.map((e) => e.periodMs);

export interface NobitexFetcherOptions {
  /** Symbol, defaults to "USDTIRT". */
  readonly symbol?: string;
  /** Per-request timeout in ms. */
  readonly timeoutMs?: number;
}

export function createNobitexFetcher(opts: NobitexFetcherOptions = {}): Fetcher {
  const symbol = opts.symbol ?? "USDTIRT";
  const timeoutMs = opts.timeoutMs;

  return {
    nativePeriodsMs: NOBITEX_PERIODS_MS,

    async fetchRange(req: FetchRangeOptions): Promise<PricePoint[]> {
      const periodMs = pickResolution(NOBITEX_PERIODS_MS, req.maxDeltaTMs);
      const entry = NOBITEX_LADDER.find((e) => e.periodMs === periodMs)!;
      if (!entry) {
        // Unreachable: pickResolution always returns a member of NOBITEX_PERIODS_MS.
        throw new Error(`nobitex fetcher: no resolution for period ${periodMs}ms`);
      }

      const res = await fetchOhlc({
        symbol,
        resolution: entry.resolution,
        fromMs: req.range.min,
        toMs: req.range.max,
        timeoutMs,
      });

      // null means "no_data" — return an empty array, not an error.
      if (res === null) return [];

      // ohlcToPriceSeries already converts epoch seconds -> ms and validates.
      return ohlcToPriceSeries(res).observations as PricePoint[];
    },
  };
}
