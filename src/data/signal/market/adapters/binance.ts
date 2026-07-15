/**
 * Binance PAXG/USDT (Pax Gold) market data fetcher.
 *
 * Uses Binance's public klines (OHLCV) endpoint. No API key required,
 * CORS is natively supported for browser environments.
 *
 * Endpoint: https://api.binance.com/api/v3/klines
 */

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
