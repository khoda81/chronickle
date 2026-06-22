/**
 * Nobitex market data fetcher.
 *
 * Uses the public trades endpoint (`GET /v2/trades/SYMBOL`) to fetch raw
 * trade history for the heatmap. Trades are irregularly spaced in time, so
 * we resample them onto a uniform `dt` grid (last price per bucket) and then
 * compute the absolute log-return |log(P_t) - log(P_{t-dt})|.
 *
 * Endpoint: https://apiv2.nobitex.ir/v2/trades/SYMBOL
 *   Response: { status: "ok", trades: [{ time, price, volume, type }, ...] }
 *   - time:  epoch milliseconds
 *   - price: string
 *   - type:  "buy" | "sell"
 *
 * Note: the public trades endpoint returns only recent trades (no historical
 * pagination). For the MVP this is sufficient; the resampler degrades
 * gracefully when the window is sparse.
 */

import type { HeatSample, HeatSeries } from "../domain.ts";

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
  /** Symbol, e.g. "usdt-rls" (USD/IRT). Defaults to "usdt-rls". */
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
  const symbol = opts.symbol ?? "usdt-rls";
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
 * Resample irregularly-spaced trades onto a uniform `dtMs` grid.
 *
 * For each bucket [t0 + k*dt, t0 + (k+1)*dt), the last trade price in that
 * bucket is used. Buckets with no trades are filled by carrying forward the
 * last known price (forward-fill), so the log-derivative is defined everywhere.
 *
 * The first bucket's dI is 0 (no prior price).
 *
 * @throws if trades is empty or contains non-positive prices.
 */
export function tradesToHeatSeries(
  trades: readonly NobitexTrade[],
  dtMs: number,
): HeatSeries {
  if (trades.length === 0) {
    return { samples: [], dt: dtMs, maxDI: 0 };
  }
  if (!(dtMs > 0)) {
    throw new Error(`dtMs must be positive, got ${dtMs}`);
  }

  // Sort ascending by time. The endpoint returns most-recent-first.
  const sorted = [...trades].sort((a, b) => a.time - b.time);

  // Validate prices up front so we fail fast on garbage.
  const priced = sorted.map((t) => {
    const price = Number(t.price);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Invalid trade price: ${t.price}`);
    }
    return { t: t.time, price };
  });

  const tMin = priced[0]!.t;
  const tMax = priced[priced.length - 1]!.t;
  const bucketCount = Math.max(1, Math.floor((tMax - tMin) / dtMs) + 1);

  // Last price per bucket.
  const lastPriceInBucket = new Array<number | null>(bucketCount).fill(null);
  for (const { t, price } of priced) {
    const idx = Math.min(bucketCount - 1, Math.floor((t - tMin) / dtMs));
    lastPriceInBucket[idx] = price; // later trades overwrite earlier ones
  }

  // Forward-fill, compute log-derivative, track max.
  const samples: HeatSample[] = new Array(bucketCount);
  let maxDI = 0;
  let prevLog: number | null = null;

  for (let i = 0; i < bucketCount; i++) {
    const price = lastPriceInBucket[i] ?? prevPrice(lastPriceInBucket, i);
    if (price === null) {
      // Leading empty buckets (shouldn't happen since bucket 0 has a trade).
      throw new Error(`No price available for bucket ${i}`);
    }
    const t = tMin + i * dtMs;
    const logP = Math.log(price);
    const dI = prevLog === null ? 0 : Math.abs(logP - prevLog);
    samples[i] = { t, dI };
    if (dI > maxDI) maxDI = dI;
    prevLog = logP;
  }

  return { samples, dt: dtMs, maxDI };
}

function prevPrice(
  buckets: readonly (number | null)[],
  i: number,
): number | null {
  for (let j = i - 1; j >= 0; j--) {
    const p = buckets[j];
    if (p !== null && p !== undefined) return p;
  }
  return null;
}

/**
 * High-level helper: fetch trades and convert to a HeatSeries.
 *
 * `dtMs` defaults to 60_000 (1-minute buckets), a reasonable granularity for
 * a volatility heatmap.
 */
export async function fetchHeatSeries(
  opts: FetchPriceOptions & { dtMs?: number } = {},
): Promise<HeatSeries> {
  const dtMs = opts.dtMs ?? 60_000;
  const res = await fetchTrades(opts);
  return tradesToHeatSeries(res.trades, dtMs);
}
