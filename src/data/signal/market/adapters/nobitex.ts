/** Nobitex OHLC wire types, range fetch, and log-price conversion. */

import type { Sample } from "../../sample.ts";
import { logPriceSamples, type PricePoint } from "../price.ts";

const NOBITEX_OHLC = "https://apiv2.nobitex.ir/market/udf/history";

/** Nobitex OHLC (UDF history) response. Times are epoch **seconds**. */
export interface NobitexOhlcResponse {
  /** "ok" | "no_data". */
  readonly s: string;
  /** Epoch seconds, ascending. */
  readonly t: readonly number[];
  readonly o: readonly number[];
  readonly h: readonly number[];
  readonly l: readonly number[];
  readonly c: readonly number[];
  readonly v: readonly number[];
}

export interface FetchOhlcOptions {
  readonly symbol?: string;
  /** TradingView resolution: "1","5","15","60","240","D","W". */
  readonly resolution?: string;
  /** Inclusive start, epoch ms. */
  readonly fromMs?: number;
  /** Inclusive end, epoch ms. */
  readonly toMs: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export async function fetchOhlc(opts: FetchOhlcOptions): Promise<NobitexOhlcResponse | null> {
  const symbol = opts.symbol ?? "USDTIRT";
  const resolution = opts.resolution ?? "D";
  const to = Math.floor(opts.toMs / 1000);

  // 1. Build query parameters using URLSearchParams
  const params = new URLSearchParams({ symbol, resolution, to: to.toString() });

  // 2. Safely handle the optional fromMs
  if (opts.fromMs !== undefined) {
    const from = Math.floor(opts.fromMs / 1000);
    params.set("from", from.toString());
  }

  // 3. Attach the neatly formatted params to your base endpoint
  const url = `${NOBITEX_OHLC}?${params.toString()}`;

  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const res = await fetch(url, {
    signal:
      opts.signal === undefined ? timeoutSignal : AbortSignal.any([opts.signal, timeoutSignal]),
  });
  if (!res.ok) {
    throw new Error(`Nobitex OHLC request failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as NobitexOhlcResponse;
  // "no_data" is not an error, but it is ambiguous: the range may truly be
  // empty or Nobitex may no longer retain this resolution that far back. The
  // adapter resolves that ambiguity by probing coarser resolutions.
  if (json.s === "no_data") return null;
  if (json.s !== "ok") {
    throw new Error(`Nobitex OHLC returned status: ${json.s}`);
  }

  return json;
}

/**
 * Convert OHLC candles into a log-price signal using only the `open` of each
 * candle. The close of candle k is implied by the open of candle k+1, so we
 * drop `h`/`l`/`c`/`v`. Times are converted from epoch seconds to ms.
 */
export function ohlcToLogPriceSamples(res: NobitexOhlcResponse | null): readonly Sample[] {
  if (res === null) return [];
  const points: PricePoint[] = res.t.map((sec, i) => ({ t: sec * 1000, price: res.o[i]! }));
  return logPriceSamples(points);
}
