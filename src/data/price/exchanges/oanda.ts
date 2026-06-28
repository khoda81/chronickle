/**
 * OANDA XAU/USD market data fetcher.
 *
 * Fetches historical OHLC candles from OANDA's v3 REST API and maps them
 * into the PriceSeries domain model. We extract the 'open' price of the
 * midpoint quote to maintain consistency with your previous UDF structure.
 *
 * Endpoint: https://api-fxpractice.oanda.com/v3/instruments/{SYMBOL}/candles
 */

import { PricePoint, PriceSeries } from "../../../domain.ts";

const OANDA_PRACTICE_API = "https://api-fxpractice.oanda.com/v3/instruments";

export interface FetchOandaOptions {
  /** Symbol, defaults to "XAU_USD" */
  readonly symbol?: string;
  /** Granularity: "M1" (1 min), "H1" (1 hour), "D" (1 day), "W" (1 week) */
  readonly granularity?: string;
  /** Number of candles to retrieve (OANDA allows up to 5000 per request) */
  readonly count?: number;
  /** Bearer token for OANDA practice/live account */
  readonly token: string;
  /** Per-request timeout in ms */
  readonly timeoutMs?: number;
}

interface OandaCandle {
  readonly complete: boolean;
  /** UNIX timestamp (as a string) when Accept-Datetime-Format header is set */
  readonly time: string;
  readonly mid: {
    readonly o: string;
    readonly h: string;
    readonly l: string;
    readonly c: string;
  };
}

interface OandaResponse {
  readonly instrument: string;
  readonly granularity: string;
  readonly candles: readonly OandaCandle[];
}

/**
 * Fetch raw candles from OANDA.
 * @throws on non-OK HTTP status or network failure.
 */
export async function fetchOandaXauUsd(opts: FetchOandaOptions): Promise<PriceSeries> {
  const symbol = opts.symbol ?? "XAU_USD";
  const granularity = opts.granularity ?? "D";
  const count = (opts.count ?? 500).toString();

  const url = `${OANDA_PRACTICE_API}/${symbol}/candles?granularity=${granularity}&count=${count}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${opts.token}`,
        // Forces OANDA to return UNIX epoch strings (e.g., "1609459200.000000000")
        // instead of ISO-8601 strings, saving us a Date.parse() operation.
        "Accept-Datetime-Format": "UNIX",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`OANDA API request failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as OandaResponse;

    const points: PricePoint[] = json.candles.map((candle) => {
      // OANDA UNIX times are strings in seconds with fractional precision
      const epochSeconds = Number.parseFloat(candle.time);
      return {
        t: Math.floor(epochSeconds * 1000), // Convert to epoch ms to satisfy invariants
        price: Number.parseFloat(candle.mid.o), // Delegate validation to PriceSeries.from()
      };
    });

    // Validates positivity, finiteness, and sorts ascending
    return PriceSeries.from(points);
  } finally {
    clearTimeout(timer);
  }
}
