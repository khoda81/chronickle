/**
 * Binance PAXG/USDT (Pax Gold) market data fetcher.
 *
 * Uses Binance's public klines (OHLCV) endpoint. No API key required,
 * CORS is natively supported for browser environments.
 *
 * Endpoint: https://api.binance.com/api/v3/klines
 */

import { PricePoint, PriceSeries } from "../../../../domain.ts";

const BINANCE_KLINES = "https://api.binance.com/api/v3/klines";

export interface FetchBinanceOptions {
  /** Symbol, defaults to "PAXGUSDT" (Pax Gold vs Tether) */
  readonly symbol?: string;
  /** Valid intervals: "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M" */
  readonly interval?: string;
  /** Max 1000 data points per request */
  readonly limit?: number;
  /** Per-request timeout in ms */
  readonly timeoutMs?: number;
  /** If true, filters out Saturday/Sunday data to mimic traditional 24/5 Forex markets */
  readonly stripWeekends?: boolean;
}

/**
 * Fetch Pax Gold from Binance and map the 'Open' price to PriceSeries.
 */
export async function fetchBinanceGold(opts: FetchBinanceOptions = {}): Promise<PriceSeries> {
  const symbol = opts.symbol ?? "PAXGUSDT";
  const interval = opts.interval ?? "1d";
  const limit = opts.limit ?? 1000;

  const url = `${BINANCE_KLINES}?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);

  try {
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      throw new Error(`Binance API request failed: ${res.status} ${res.statusText}`);
    }

    // Binance returns an array of arrays.
    // Index 0: Open time (ms)
    // Index 1: Open price (string)
    const data: unknown = await res.json();
    if (!Array.isArray(data)) throw new Error("Binance API returned a non-array response");

    const points: PricePoint[] = [];

    for (const candle of data) {
      if (!Array.isArray(candle)) continue;
      const tMs = Number(candle[0]);
      const price = Number(candle[1]);

      // Optional: Wavelet transforms often prefer continuous market hours without
      // weekend illiquidity gaps. Since crypto trades 24/7, PAXG will have weekend data.
      // We can strip weekends here if requested.
      if (opts.stripWeekends) {
        const dayOfWeek = new Date(tMs).getUTCDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
          continue; // Skip Saturday (6) and Sunday (0)
        }
      }

      if (Number.isFinite(price) && price > 0) {
        points.push({
          t: tMs,
          price: price,
        });
      }
    }

    return PriceSeries.from(points);
  } finally {
    clearTimeout(timer);
  }
}
