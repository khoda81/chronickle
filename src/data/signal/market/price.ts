import type { Sample } from "../sample.ts";
import { normalizeSamples } from "../sample.ts";

/** A price observation. This type belongs to market sources, not signal core. */
export interface PricePoint {
  readonly t: number;
  readonly price: number;
}

/**
 * Convert a positive price series to the real-valued log-price signal consumed
 * by the broker. Price validation and logarithms stop at this market boundary.
 */
export function logPriceSamples(points: readonly PricePoint[]): readonly Sample[] {
  const samples: Sample[] = [];
  for (let index = 0; index < points.length; index++) {
    const point = points[index]!;
    if (!Number.isFinite(point.t)) {
      throw new Error(`logPriceSamples: non-finite timestamp at ${index}: ${point.t}`);
    }
    if (!(point.price > 0) || !Number.isFinite(point.price)) {
      throw new Error(
        `logPriceSamples: price must be finite and positive at ${index}: ${point.price}`,
      );
    }
    samples.push({ t: point.t, value: Math.log(point.price) });
  }
  return normalizeSamples(samples);
}
