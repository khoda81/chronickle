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
import { eventRowY } from "./gfx/layout.ts";

/**
 * Find the index of the nearest event under pixel (px, py), or null if none
 * is within `radius` pixels. Culls to the visible time window.
 */
export function hitTestEvent(
  events: EventSet,
  tx: DataTransform,
  px: number,
  py: number,
  heatHeight: number,
  radius = 10,
): number | null {
  const height = tx.yDomain.max - tx.yDomain.min;
  const baseY = eventRowY(height, heatHeight);
  if (Math.abs(py - baseY) > radius) return null;

  const xs = events.events;
  if (xs.length === 0) return null;

  const tMin = tx.timeDomain.min;
  const tMax = tx.timeDomain.max;
  // First index whose t >= tMin (xs.length if all are before the window).
  const lo = lowerBound(xs, tMin);
  if (lo === xs.length) return null;
  // First index whose t > tMax. Events in [lo, hi) are within [tMin, tMax].
  const hi = upperBound(xs, tMax, lo);
  if (hi === lo) return null;

  let best: number | null = null;
  let bestDist = radius;
  for (let i = lo; i < hi; i++) {
    const e = xs[i]!;
    const x = tx.timeToX(e.t);
    const d = Math.abs(x - px);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
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
