/**
 * Hit-testing for event nodes.
 *
 * Pure function of (events, transform, pointer). Used by the interaction layer
 * on pointer move — outside the render loop — so it takes a `DataTransform`
 * rather than a `Frame`.
 *
 * `EventSet.events` is sorted ascending by `t` (see `domain.ts`), so we narrow
 * to the visible window with two binary searches and scan only the candidates
 * that can possibly be on screen — O(log n + k) instead of O(n) per pointermove.
 */

import type { EventSet } from "../domain.ts";
import type { DataTransform } from "./transform.ts";


/** Find the visible event nearest to a vertical crosshair. */
export function nearestEventIndex(events: EventSet, tx: DataTransform, px: number): number | null {
  const xs = events.events;
  if (xs.length === 0) return null;
  const lo = lowerBound(xs, tx.timeDomain.min);
  const hi = upperBound(xs, tx.timeDomain.max, lo);
  if (lo === hi) return null;

  const target = tx.xToTime(px);
  const insertion = lowerBound(xs, target);
  const right = Math.min(hi - 1, Math.max(lo, insertion));
  const left = Math.max(lo, right - 1);
  return Math.abs(xs[left]!.t - target) <= Math.abs(xs[right]!.t - target) ? left : right;
}

/** First index `i` such that `xs[i].t >= t`. Assumes `xs` is sorted by `t`. */
function lowerBound(xs: readonly { readonly t: number }[], t: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]!.t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index `i` such that `xs[i].t > t`. Search starts at `from`. */
function upperBound(xs: readonly { readonly t: number }[], t: number, from: number): number {
  let lo = from;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]!.t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
