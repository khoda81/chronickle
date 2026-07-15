/**
 * Nobitex adapter for the subscription contract.
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

import { createPollingSignalSource, type SignalAdapter } from "../../fetcher.ts";
import { pickResolution } from "../../resolution.ts";
import { fetchOhlc, ohlcToLogPriceSamples } from "./nobitex.ts";

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

export interface NobitexAdapterOptions {
  /** Symbol, defaults to "USDTIRT". */
  readonly symbol?: string;
  /** Per-request timeout in ms. */
  readonly timeoutMs?: number;
}

export function createNobitexAdapter(opts: NobitexAdapterOptions = {}): SignalAdapter {
  const symbol = opts.symbol ?? "USDTIRT";
  const timeoutMs = opts.timeoutMs;

  return createPollingSignalSource({
    minFetchPoints: 256,
    livePollDelayMs: 1_000,
    // Nobitex applies endpoint-wide throttling. The broker owns transient
    // failure state but asks the adapter how long to suppress retries.
    retryDelayMs(_error, attempt) {
      return Math.min(60_000, 2_000 * 2 ** (attempt - 1));
    },

    resolve(req) {
      return pickResolution(NOBITEX_PERIODS_MS, req.maxDeltaTMs);
    },

    async fetchRange(req, signal) {
      const periodMs = req.resolutionMs;
      const entry = NOBITEX_LADDER.find((e) => e.periodMs === periodMs)!;
      if (!entry) {
        // Unreachable: pickResolution always returns a member of NOBITEX_PERIODS_MS.
        throw new Error(`nobitex fetcher: no resolution for period ${periodMs}ms`);
      }

      // Include one predecessor candle so zero-order hold is defined at the
      // requested left boundary even when it falls between candle opens.
      const res = await fetchOhlc({
        symbol,
        resolution: entry.resolution,
        fromMs: req.range.min - periodMs,
        toMs: req.range.max,
        timeoutMs,
        signal,
      });

      // "no_data" means no candles exist for this range at all — the request
      // is exhausted and the broker should not retry it.
      if (res === null) {
        return {
          samples: [],
          searchedRange: req.range,
        };
      }

      const samples = ohlcToLogPriceSamples(res);
      if (samples.length === 0) {
        return {
          samples: [],
          searchedRange: req.range,
        };
      }

      const firstT = samples[0]!.t;
      // Nobitex caps OHLC responses at 1000 candles anchored at `to`. If the
      // first returned candle is strictly after `from`, the prefix
      // [from, firstT) was truncated and still needs to be fetched. We report
      // only the actually-covered sub-range so the broker keeps that prefix as
      // a gap and re-requests it on the next query (progressive backfill).
      //
      // If the first candle is at or before `from`, the response was not
      // truncated on the left, so the whole request is exhausted.
      if (firstT <= req.range.min) {
        return {
          samples,
          searchedRange: req.range,
        };
      }
      if (firstT < req.range.max) {
        return {
          samples,
          searchedRange: { min: firstT, max: req.range.max },
        };
      }
      return {
        samples,
        searchedRange: req.range,
      };
    },
  });
}
