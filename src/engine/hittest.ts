/**
 * Hit-testing for event nodes.
 *
 * Pure function of (events, transform, pointer). Used by the interaction layer
 * on pointer move — outside the render loop — so it takes a `DataTransform`
 * rather than a `Frame`.
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
  radius = 10,
): number | null {
  const height = tx.yDomain.max - tx.yDomain.min;
  const baseY = eventRowY(height);
  if (Math.abs(py - baseY) > radius) return null;

  let best: number | null = null;
  let bestDist = radius;
  for (let i = 0; i < events.events.length; i++) {
    const e = events.events[i]!;
    if (!tx.containsTime(e.t)) continue;
    const x = tx.timeToX(e.t);
    const d = Math.abs(x - px);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}
