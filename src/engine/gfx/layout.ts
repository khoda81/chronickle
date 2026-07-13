/** Shared vertical layout measurements, in CSS pixels. */

/** Initial user-resizable heatmap height. */
export const DEFAULT_HEAT_HEIGHT = 220;
export const MIN_HEAT_HEIGHT = 96;
export const MAX_HEAT_HEIGHT = 420;

/** Coverage/resolution diagnostics below the transform. */
export const RESOLUTION_BAR_HEIGHT = 34;
/** Hit target around the heatmap's upper resize edge. */
export const RESIZE_HANDLE_RADIUS = 6;

/** Smallest Gaussian sigma (in horizontal device pixels). */
export const MIN_SIGMA = 14;
/** Largest Gaussian sigma, capped to keep context finite. */
export const MAX_SIGMA_CAP = 128;

export function maxSigmaFor(numPx: number): number {
  return Math.max(MIN_SIGMA, Math.min(MAX_SIGMA_CAP, numPx / 4));
}

/** Height reserved for the news row above the time axis. */
export const EVENT_AREA_HEIGHT = 80;

export function clampHeatHeight(height: number, canvasHeight: number): number {
  // Preserve enough room for the axis and news row even in a short canvas.
  const available = Math.max(MIN_HEAT_HEIGHT, canvasHeight - RESOLUTION_BAR_HEIGHT - 112);
  return Math.min(Math.max(height, MIN_HEAT_HEIGHT), Math.min(MAX_HEAT_HEIGHT, available));
}

export function resolutionBarY(height: number): number {
  return height - RESOLUTION_BAR_HEIGHT;
}

export function heatTopY(height: number, heatHeight: number): number {
  return resolutionBarY(height) - heatHeight;
}

export function heatBottomY(height: number): number {
  return resolutionBarY(height);
}

export function axisY(height: number, heatHeight: number): number {
  return heatTopY(height, heatHeight) - 6;
}

export function eventRowY(height: number, heatHeight: number): number {
  return axisY(height, heatHeight) - EVENT_AREA_HEIGHT / 2;
}
