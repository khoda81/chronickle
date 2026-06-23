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

import { PricePoint, PriceSeries } from "../domain.ts";

const NOBITEX_TRADES = "https://apiv2.nobitex.ir/v2/trades";

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

/**
 * Fetch raw trades from Nobitex.
 * @throws on non-OK HTTP status, non-"ok" payload status, or malformed JSON.
 */
export async function fetchTrades(
  opts: FetchPriceOptions = {},
): Promise<NobitexTradesResponse> {
  const symbol = opts.symbol ?? "USDTIRT";
  const url = `${NOBITEX_TRADES}/${encodeURIComponent(symbol)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(
        `Nobitex trades request failed: ${res.status} ${res.statusText}`,
      );
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
export function tradesToPriceSeries(
  trades: readonly NobitexTrade[],
): PriceSeries {
  const points: PricePoint[] = trades.map((t) => ({
    t: t.time,
    price: Number(t.price),
  }));
  return PriceSeries.from(points);
}

/**
 * High-level helper: fetch trades and convert to a PriceSeries.
 */
export async function fetchPriceSeries(
  opts: FetchPriceOptions = {},
): Promise<PriceSeries> {
  const res = await fetchTrades(opts);
  return tradesToPriceSeries(res.trades);
}
