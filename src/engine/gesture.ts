import type { Range } from "./range.ts";

const MIN_PINCH_DISTANCE_PX = 4;

/**
 * Apply one incremental two-finger gesture to a time range.
 *
 * The time below the previous centroid follows the fingers to the current
 * centroid while the change in finger distance controls the visible span.
 * This combines pinch and two-finger pan without applying two independent
 * range updates (which would make the result depend on event order).
 */
export function transformTouchRange(
  range: Range,
  viewportWidth: number,
  previousCenterX: number,
  currentCenterX: number,
  previousDistance: number,
  currentDistance: number,
): Range {
  if (!(viewportWidth > 0) || !Number.isFinite(viewportWidth)) {
    throw new Error(`transformTouchRange: invalid viewport width ${viewportWidth}`);
  }

  const span = range.max - range.min;
  const scale =
    previousDistance >= MIN_PINCH_DISTANCE_PX && currentDistance >= MIN_PINCH_DISTANCE_PX
      ? currentDistance / previousDistance
      : 1;
  const nextSpan = span / scale;
  const anchorTime = range.min + (previousCenterX / viewportWidth) * span;
  const nextMin = anchorTime - (currentCenterX / viewportWidth) * nextSpan;
  const nextMax = nextMin + nextSpan;
  if (!(nextMin < nextMax) || !Number.isFinite(nextMin) || !Number.isFinite(nextMax)) {
    throw new Error(`transformTouchRange: gesture produced invalid range ${nextMin}..${nextMax}`);
  }
  return { min: nextMin, max: nextMax };
}
