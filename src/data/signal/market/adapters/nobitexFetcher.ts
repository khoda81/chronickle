/**
 * Nobitex adapter for the subscription contract.
 *
 * Wraps the existing `fetchOhlc` and maps the requested query grid to the
 * coarsest retained Nobitex TradingView resolution that can represent it.
 * Nobitex OHLC returns timestamps in epoch **seconds**; this adapter
 * converts to milliseconds at the boundary so the rest of the data layer
 * only ever sees ms.
 *
 * Nobitex resolution table (period in seconds):
 *   60 ("1"), 300 ("5"), 900 ("15"), 1800 ("30"),
 *   3600 ("60"), 10800 ("180"), 14400 ("240"), 21600 ("360"),
 *   43200 ("720"), 86400 ("D"), 172800 ("2D"), 259200 ("3D")
 */

import { Interval } from "../../../../core/interval.ts";
import {
  createPollingSignalSource,
  demandSampleSpacingMs,
  type SignalAdapter,
} from "../../fetcher.ts";
import { pickResolution } from "../../resolution.ts";
import { fetchOhlc, ohlcToLogPriceSamples } from "./nobitex.ts";

const MS = 1000;

// TODO: Can this be a record or a map instead of list?
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

const NOBITEX_PERIODS_MS: readonly number[] = NOBITEX_LADDER.map(e => e.periodMs);

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
      return pickResolution(NOBITEX_PERIODS_MS, demandSampleSpacingMs(req));
    },

    async fetchInterval(req, signal) {
      const requestedIndex = NOBITEX_LADDER.findIndex(e => e.periodMs === req.resolutionMs);
      if (requestedIndex < 0) {
        // Unreachable: pickResolution always returns a member of NOBITEX_PERIODS_MS.
        throw new Error(`nobitex fetcher: no resolution for period ${req.resolutionMs}ms`);
      }

      // Nobitex returns the same `no_data` response for a genuinely empty range
      // and for fine history it no longer retains. Probe progressively coarser
      // native levels so an empty fine response does not become false no-data
      // evidence. The coordinator still settles the attempted fine search,
      // while `sampleResolutionMs` preserves the fallback's actual quality.
      for (let index = requestedIndex; index < NOBITEX_LADDER.length; index++) {
        const { resolution, periodMs } = NOBITEX_LADDER[index]!;
        const res = await fetchOhlc({
          symbol,
          resolution,
          // Include one predecessor candle so zero-order hold is defined at
          // the left boundary when it falls between candle opens.
          fromMs: req.range.start - periodMs,
          toMs: req.range.end,
          timeoutMs,
          signal,
        });
        const samples = ohlcToLogPriceSamples(res);
        if (samples.length === 0) continue;

        // Nobitex caps responses at 500 candles anchored at `to`. A later first
        // candle means the prefix was truncated and remains schedulable.
        const searchedInterval = Interval.clampStart(req.range, samples[0]!.t);
        return { samples, searchedInterval, sampleResolutionMs: periodMs };
      }

      // Every available native level agreed that the range is empty.
      return { samples: [], searchedInterval: req.range };
    },
  });
}
