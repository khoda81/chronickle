/**
 * Yahoo Finance Stock Data Fetcher (SpaceX).
 *
 * Fetches traditional equity data using Yahoo's v8 chart API.
 * Because Yahoo Finance does not support CORS for direct browser access,
 * this utilizes a public CORS proxy.
 */

import { PricePoint, PriceSeries } from "../../../domain.ts";

// Public CORS proxy to bypass browser restrictions on Yahoo Finance
const CORS_PROXY = "https://corsproxy.io/?";
const YAHOO_CHART_API = "https://query2.finance.yahoo.com/v8/finance/chart";

export interface FetchStockOptions {
  /** Symbol, defaults to "SPCX" (SpaceX) */
  readonly symbol?: string;
  /** Valid intervals: "1m", "2m", "5m", "15m", "30m", "60m", "1d", "1wk", "1mo" */
  readonly interval?: string;
  /** Valid ranges: "1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "max" */
  readonly range?: string;
  /** Per-request timeout in ms */
  readonly timeoutMs?: number;
}

/**
 * Fetch stock data from Yahoo Finance and map the 'Open' price to PriceSeries.
 */
export async function fetchSpaceXStock(opts: FetchStockOptions = {}): Promise<PriceSeries> {
  const symbol = opts.symbol ?? "SPCX";
  const interval = opts.interval ?? "1d";
  const range = opts.range ?? "1mo";

  // Construct the Yahoo API URL
  const targetUrl = `${YAHOO_CHART_API}/${symbol}?interval=${interval}&range=${range}`;

  // Wrap it in the CORS proxy
  const url = `${CORS_PROXY}${encodeURIComponent(targetUrl)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);

  try {
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      throw new Error(`Yahoo Finance API request failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const result = data?.chart?.result?.[0];

    if (!result || !result.timestamp || !result.indicators?.quote?.[0]) {
      // Return empty series if the market hasn't opened yet or data is malformed
      return PriceSeries.from([]);
    }

    const timestamps: number[] = result.timestamp; // Timestamps are in seconds
    const opens: (number | null)[] = result.indicators.quote[0].open;

    const points: PricePoint[] = [];

    for (let i = 0; i < timestamps.length; i++) {
      const tSec = timestamps[i];
      if (tSec === undefined) continue;
      const tMs = tSec * 1000; // Convert seconds to milliseconds
      const price = opens[i];

      // Yahoo Finance sometimes includes nulls for halted trading minutes/days
      if (price !== null && price !== undefined && Number.isFinite(price) && price > 0) {
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
