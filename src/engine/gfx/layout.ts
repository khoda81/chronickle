/**
 * Shared vertical layout constants (CSS pixels).
 *
 * Centralized so the heatmap, event, and axis layers agree on geometry. These
 * are pure values; the layers read them directly.
 */

/** Height of the heatmap strip at the bottom of the canvas. */
export const HEAT_HEIGHT = 220;
/** Number of vertical frequency scales. */
export const NUM_BANDS = 32; // Number of vertical frequency scales

/**
 * Smallest Gaussian sigma (in pixels) used by the wavelet heatmap. Below
 * this the triple-box approximation degrades, and finer detail than this is
 * not meaningful on a scrubbable timeline.
 */
export const MIN_SIGMA = 14;
/** Largest Gaussian sigma (in pixels), capped to keep the kernel finite. */
export const MAX_SIGMA_CAP = 128;

/**
 * Largest Gaussian sigma (in pixels) for a heatmap of `numPx` device pixels.
 * Capped at `MAX_SIGMA_CAP` and at `numPx/4` so the kernel never reaches
 * across more than a quarter of the viewport — beyond that the bottom band
 * is a flat smear with no useful information.
 */
export function maxSigmaFor(numPx: number): number {
  return Math.max(MIN_SIGMA, Math.min(MAX_SIGMA_CAP, numPx / 4));
}
/** Height of the event-node row above the heatmap. */
export const EVENT_AREA_HEIGHT = 80;
/** Top padding above the event row. */
export const TOP_PADDING = 24;

/** Y center of the event row. */
export function eventRowY(height: number): number {
  return height - (TOP_PADDING + EVENT_AREA_HEIGHT / 2);
}

/** Y of the axis tick line (just above the heatmap). */
export function axisY(height: number): number {
  return height - HEAT_HEIGHT - 6;
}

/** Y of the top of the heatmap strip. */
export function heatTopY(height: number): number {
  return height - HEAT_HEIGHT;
}
