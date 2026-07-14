/** Shared stacked-timeline layout measurements, in CSS pixels. */

export const DEFAULT_NEWS_HEIGHT = 110;
export const MIN_NEWS_HEIGHT = 64;
export const MIN_PRICE_ROW_HEIGHT = 130;

/** Coverage/resolution diagnostics at the bottom of every price row. */
export const RESOLUTION_BAR_HEIGHT = 34;
/** Shared intrinsic heatmap height. Rows crop this field instead of stretching it. */
export const HEATMAP_FIELD_HEIGHT = 640;
/** Pointer hit target around each draggable horizontal boundary. */
export const RESIZE_HANDLE_RADIUS = 6;

export const MIN_SIGMA = 14;
export const MAX_SIGMA_CAP = 128;

export function maxSigmaFor(numPx: number): number {
  return Math.max(MIN_SIGMA, Math.min(MAX_SIGMA_CAP, numPx / 4));
}

/** Keep a vertically-panned fixed-height field covering its row viewport. */
export function clampHeatmapOffset(offset: number, viewportHeight: number): number {
  const min = Math.min(0, viewportHeight - HEATMAP_FIELD_HEIGHT);
  const max = Math.max(0, viewportHeight - HEATMAP_FIELD_HEIGHT);
  return clamp(offset, min, max);
}

export interface StackLayout {
  readonly newsHeight: number;
  readonly rowHeights: readonly number[];
}

/** Fit a news row and N price rows exactly into the available canvas height. */
export function fitStackLayout(
  newsHeight: number,
  rowHeights: readonly number[],
  totalHeight: number,
): StackLayout {
  const total = Math.max(0, totalHeight);
  const count = rowHeights.length;
  if (count === 0) return { newsHeight: total, rowHeights: [] };

  // Small embeds may not have enough room for the preferred minima. In that
  // case all rows shrink proportionally while remaining usable.
  const minNews = Math.min(MIN_NEWS_HEIGHT, total / (count + 1));
  const minPrice = Math.min(MIN_PRICE_ROW_HEIGHT, (total - minNews) / count);
  const fittedNews = clamp(newsHeight, minNews, Math.max(minNews, total - minPrice * count));
  const priceSpace = Math.max(0, total - fittedNews);
  const extra = Math.max(0, priceSpace - minPrice * count);
  const weights = rowHeights.map((height) => Math.max(1, height - minPrice));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const fittedRows = weights.map((weight) => minPrice + (extra * weight) / weightSum);

  return { newsHeight: fittedNews, rowHeights: fittedRows };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
