/**
 * Shared vertical layout constants (CSS pixels).
 *
 * Centralized so the heatmap, event, and axis layers agree on geometry. These
 * are pure values; the layers read them directly.
 */

/** Height of the heatmap strip at the bottom of the canvas. */
export const HEAT_HEIGHT = 120;
/** Height of the event-node row above the heatmap. */
export const EVENT_AREA_HEIGHT = 80;
/** Top padding above the event row. */
export const TOP_PADDING = 24;

/** Y center of the event row. */
export function eventRowY(height: number): number {
  return TOP_PADDING + EVENT_AREA_HEIGHT / 2;
}

/** Y of the axis tick line (just above the heatmap). */
export function axisY(height: number): number {
  return height - HEAT_HEIGHT - 6;
}

/** Y of the top of the heatmap strip. */
export function heatTopY(height: number): number {
  return height - HEAT_HEIGHT;
}
