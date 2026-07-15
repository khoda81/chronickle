/**
 * Nobitex market data fetcher.
 *
 * Uses the public trades endpoint (`GET /v2/trades/SYMBOL`) to fetch raw
 * trade history. Trades are returned as-is (irregularly spaced, duplicate
 * timestamps allowed) and wrapped into a PriceSeries — no resampling.
 *
 * Endpoint: https://apiv2.nobitex.ir/v2/trades/SYMBOL
 *   Response: { status: "ok", trades: [{ time, price, volume, type }, ...] }
 *   - time:  epoch milliseconds
 *   - price: string
 *   - type:  "buy" | "sell"
 *
 * Note: the public trades endpoint returns only recent trades (no historical
 * pagination). For longer history, the OHLC endpoint should be used instead.
 */

import { PricePoint, PriceSeries } from "../../../domain.ts";

const NOBITEX_TRADES = "https://apiv2.nobitex.ir/v2/trades";
const NOBITEX_OHLC = "https://apiv2.nobitex.ir/market/udf/history";

export interface NobitexTrade {
  /** Epoch milliseconds. */
  readonly time: number;
  readonly price: string;
  readonly volume: string;
  readonly type: "buy" | "sell";
}

export interface NobitexTradesResponse {
  readonly status: string;
  readonly trades: readonly NobitexTrade[];
}

export interface FetchPriceOptions {
  /** Symbol, e.g. "USDTIRT" (USD/IRT). Defaults to "USDTIRT". */
  readonly symbol?: string;
  /** Per-request timeout in ms. */
  readonly timeoutMs?: number;
}

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

/**
 * Fetch raw trades from Nobitex.
 * @throws on non-OK HTTP status, non-"ok" payload status, or malformed JSON.
 */
export async function fetchTrades(opts: FetchPriceOptions = {}): Promise<NobitexTradesResponse> {
  const symbol = opts.symbol ?? "USDTIRT";
  const url = `${NOBITEX_TRADES}/${encodeURIComponent(symbol)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Nobitex trades request failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as NobitexTradesResponse;
    if (json.status !== "ok") {
      throw new Error(`Nobitex trades returned status: ${json.status}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convert raw Nobitex trades into a PriceSeries. Trades are mapped 1:1 to
 * PricePoints (no resampling, no deduplication). Price validation is
 * delegated to PriceSeries.from.
 */
export function tradesToPriceSeries(trades: readonly NobitexTrade[]): PriceSeries {
  const points: PricePoint[] = trades.map((t) => ({
    t: t.time,
    price: Number(t.price),
  }));
  return PriceSeries.from(points);
}

/**
 * High-level helper: fetch trades and convert to a PriceSeries.
 */
export async function fetchPriceSeries(opts: FetchPriceOptions = {}): Promise<PriceSeries> {
  const res = await fetchTrades(opts);
  return tradesToPriceSeries(res.trades);
}
export async function fetchOhlc(opts: FetchOhlcOptions): Promise<NobitexOhlcResponse | null> {
  const symbol = opts.symbol ?? "USDTIRT";
  const resolution = opts.resolution ?? "D";
  const to = Math.floor(opts.toMs / 1000);

  // 1. Build query parameters using URLSearchParams
  const params = new URLSearchParams({
    symbol,
    resolution,
    to: to.toString(),
  });

  // 2. Safely handle the optional fromMs
  if (opts.fromMs !== undefined) {
    const from = Math.floor(opts.fromMs / 1000);
    params.set("from", from.toString());
  }

  // 3. Attach the neatly formatted params to your base endpoint
  const url = `${NOBITEX_OHLC}?${params.toString()}`;

  const controller = new AbortController();
  const abort = (): void => controller.abort();
  opts.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Nobitex OHLC request failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as NobitexOhlcResponse;
    // "no_data" is not an error — it means no candles exist for this range
    // (e.g. before the symbol listed, or future dates). Return null so the
    // caller can treat it as an empty result rather than an exceptional case.
    if (json.s === "no_data") return null;
    if (json.s !== "ok") {
      throw new Error(`Nobitex OHLC returned status: ${json.s}`);
    }

    return json;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abort);
  }
}

/**
 * Convert OHLC candles into a PriceSeries using only the `open` of each
 * candle. The close of candle k is implied by the open of candle k+1, so we
 * drop `h`/`l`/`c`/`v`. Times are converted from epoch seconds to ms.
 */
export function ohlcToPriceSeries(res: NobitexOhlcResponse | null): PriceSeries {
  if (res === null) return PriceSeries.EMPTY;
  const points: PricePoint[] = res.t.map((sec, i) => ({
    t: sec * 1000,
    price: res.o[i]!,
  }));
  return PriceSeries.from(points);
}

/**
 * High-level helper: fetch OHLC and convert to a PriceSeries (open-only).
 */
export async function fetchOhlcPriceSeries(opts: FetchOhlcOptions): Promise<PriceSeries> {
  const res = await fetchOhlc(opts);
  return ohlcToPriceSeries(res);
}
