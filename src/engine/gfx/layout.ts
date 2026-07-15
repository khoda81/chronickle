/** Shared stacked-timeline layout measurements, in CSS pixels. */

export const DEFAULT_NEWS_HEIGHT = 110;
export const MIN_NEWS_HEIGHT = 64;
export const MIN_PRICE_ROW_HEIGHT = 130;

/** Coverage/resolution diagnostics at the bottom of every price row. */
export const RESOLUTION_BAR_HEIGHT = 8;
/** Reference height that defines the logarithmic vertical scale spacing. */
export const HEATMAP_FIELD_HEIGHT = 640;
/** Maximum horizontal supersampling used when viewing sub-pixel scales. */
const MAX_SAMPLE_DENSITY = 8;
/** Maximum horizontal decimation used when viewing very broad scales. */
const MAX_SAMPLE_STRIDE = 64;
/** Pointer hit target around each draggable horizontal boundary. */
export const RESIZE_HANDLE_RADIUS = 6;

export const MIN_SIGMA = 14;
export const MAX_SIGMA_CAP = 128;

export function maxSigmaFor(numPx: number): number {
  return Math.max(MIN_SIGMA, Math.min(MAX_SIGMA_CAP, numPx / 4));
}

export interface HeatmapScaleWindow {
  /** Visible logarithmic scale range, expressed in physical screen pixels. */
  readonly minSigmaPx: number;
  readonly maxSigmaPx: number;
  /** Number of uniform time cells required across the visible width. */
  readonly sampleCellCount: number;
}

/**
 * Map an unbounded vertical pan to a visible logarithmic scale window.
 *
 * At offset zero this exactly follows the old 640-row intrinsic field. Rows
 * outside that old field continue the same logarithmic progression instead of
 * becoming blank. The smallest visible scale also selects a power-of-two
 * horizontal sampling stride, keeping at least MIN_SIGMA input cells beneath
 * the finest convolution while avoiding request churn for every drag pixel.
 */
export function heatmapScaleWindow(
  numDevicePx: number,
  viewportHeight: number,
  verticalOffset: number,
): HeatmapScaleWindow {
  if (!(numDevicePx > 0) || !Number.isFinite(numDevicePx)) {
    throw new Error(`heatmapScaleWindow: invalid width ${numDevicePx}`);
  }
  if (!(viewportHeight > 0) || !Number.isFinite(viewportHeight)) {
    throw new Error(`heatmapScaleWindow: invalid height ${viewportHeight}`);
  }
  if (!Number.isFinite(verticalOffset)) {
    throw new Error(`heatmapScaleWindow: invalid offset ${verticalOffset}`);
  }

  const maxSigma = maxSigmaFor(numDevicePx);
  const logStep = Math.log(maxSigma / MIN_SIGMA) / (HEATMAP_FIELD_HEIGHT - 1);
  const firstFieldRow = -verticalOffset;
  const lastFieldRow = firstFieldRow + Math.max(1, Math.ceil(viewportHeight) - 1);
  const minSigmaPx = MIN_SIGMA * Math.exp(logStep * firstFieldRow);
  const maxSigmaPx = MIN_SIGMA * Math.exp(logStep * lastFieldRow);

  const idealStride = minSigmaPx / MIN_SIGMA;
  const quantizedStride = 2 ** Math.floor(Math.log2(idealStride));
  const stride = Math.max(1 / MAX_SAMPLE_DENSITY, Math.min(MAX_SAMPLE_STRIDE, quantizedStride));
  const sampleCellCount = Math.max(2, Math.ceil(numDevicePx / stride));
  return { minSigmaPx, maxSigmaPx, sampleCellCount };
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
