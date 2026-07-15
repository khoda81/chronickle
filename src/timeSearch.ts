export interface Timestamped {
  readonly t: number;
}

/** First index `i` at or after `from` such that `items[i].t >= time`. */
export function lowerBoundTime(items: readonly Timestamped[], time: number, from = 0): number {
  return timeBound(items, time, from, false);
}

/** First index `i` at or after `from` such that `items[i].t > time`. */
export function upperBoundTime(items: readonly Timestamped[], time: number, from = 0): number {
  return timeBound(items, time, from, true);
}

function timeBound(
  items: readonly Timestamped[],
  time: number,
  from: number,
  skipEqual: boolean,
): number {
  let lo = from;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = items[mid]!.t;
    if (candidate < time || (skipEqual && candidate === time)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
