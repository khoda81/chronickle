import { lowerBoundBy, upperBoundBy } from "./core/binarySearch.ts";

export interface Timestamped {
  readonly t: number;
}

const timestamp = (item: Timestamped): number => item.t;

/** First index `i` at or after `from` such that `items[i].t >= time`. */
export function lowerBoundTime(items: readonly Timestamped[], time: number, from = 0): number {
  return lowerBoundBy(items, time, timestamp, from);
}

/** First index `i` at or after `from` such that `items[i].t > time`. */
export function upperBoundTime(items: readonly Timestamped[], time: number, from = 0): number {
  return upperBoundBy(items, time, timestamp, from);
}
