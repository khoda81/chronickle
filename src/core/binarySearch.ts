/** Returns the first index whose numeric key is greater than or equal to `target`. */
export function lowerBoundBy<T>(
  items: ArrayLike<T>,
  target: number,
  keyOf: (item: T) => number,
  from = 0,
): number {
  let lo = from;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keyOf(items[mid]!) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Returns the first index whose numeric key is greater than `target`. */
export function upperBoundBy<T>(
  items: ArrayLike<T>,
  target: number,
  keyOf: (item: T) => number,
  from = 0,
): number {
  let lo = from;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keyOf(items[mid]!) <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
