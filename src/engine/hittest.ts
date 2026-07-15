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
import { lowerBoundTime, upperBoundTime } from "../timeSearch.ts";
import type { DataTransform } from "./transform.ts";

/** Find the last visible event at or before a vertical crosshair. */
export function eventIndexAtOrBefore(
  events: EventSet,
  tx: DataTransform,
  px: number,
): number | null {
  const xs = events.events;
  if (xs.length === 0) return null;
  const lo = lowerBoundTime(xs, tx.timeDomain.min);
  const hi = upperBoundTime(xs, tx.timeDomain.max, lo);
  if (lo === hi) return null;

  const target = tx.xToTime(px);
  const index = upperBoundTime(xs, target, lo) - 1;
  return index >= lo && index < hi ? index : null;
}

/** Find a visible event node close enough to be clicked. */
export function eventIndexNearPoint(
  events: EventSet,
  tx: DataTransform,
  px: number,
  py: number,
  eventY: number,
  radiusPx = 12,
): number | null {
  if (Math.abs(py - eventY) > radiusPx) return null;
  const xs = events.events;
  if (xs.length === 0) return null;
  const lo = lowerBoundTime(xs, tx.timeDomain.min);
  const hi = upperBoundTime(xs, tx.timeDomain.max, lo);
  if (lo === hi) return null;

  const target = tx.xToTime(px);
  const insertion = upperBoundTime(xs, target, lo);
  let best: number | null = null;
  let bestDistance = radiusPx;
  for (const index of [insertion - 1, insertion]) {
    if (index < lo || index >= hi) continue;
    const distance = Math.abs(tx.timeToX(xs[index]!.t) - px);
    if (distance <= bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}
