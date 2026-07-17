/** Shared stacked-timeline layout measurements, in CSS pixels. */

export const DEFAULT_NEWS_HEIGHT = 110;
export const MIN_NEWS_HEIGHT = 64;
export const DEFAULT_SIGNAL_ROW_HEIGHT = 130;

/** Sample density and request diagnostics above every signal heatmap. */
export const COVERAGE_BAR_HEIGHT = 16;
/** A heatmap needs at least two CSS pixels below its status strip. */
const MIN_HEATMAP_HEIGHT = 2;
/** Height over which a boundary drag transitions into the remove affordance. */
export const ROW_COLLAPSE_HINT_HEIGHT = 128;
/** A row at or below this height is removed when a resize gesture commits. */
export const ROW_REMOVE_THRESHOLD = 64;
/** Reference height that defines the logarithmic vertical scale spacing. */
const HEATMAP_FIELD_HEIGHT = 640;
/** Pointer hit target around each draggable horizontal boundary. */
export const RESIZE_HANDLE_RADIUS = 6;

export interface SignalRowLayout {
  readonly top: number;
  readonly height: number;
  readonly heatmapTop: number;
  readonly heatmapHeight: number;
  readonly heatmapCenter: number;
  readonly drawable: boolean;
}

/** Resolve all vertical signal-row geometry in one place. */
export function signalRowLayout(top: number, height: number): SignalRowLayout {
  const heatmapTop = top + COVERAGE_BAR_HEIGHT;
  const heatmapHeight = Math.max(0, height - COVERAGE_BAR_HEIGHT);
  return {
    top,
    height,
    heatmapTop,
    heatmapHeight,
    heatmapCenter: heatmapTop + heatmapHeight / 2,
    drawable: heatmapHeight > MIN_HEATMAP_HEIGHT,
  };
}

/** True when a canvas y-coordinate belongs to the row's heatmap, not its status strip. */
export function signalRowContainsHeatmap(top: number, height: number, y: number): boolean {
  const layout = signalRowLayout(top, height);
  return layout.drawable && y >= layout.heatmapTop && y < top + height;
}

/** Remove-affordance progress for the row touched by the active boundary. */
export function signalRowCollapseProgress(
  rowIndex: number,
  rowHeight: number,
  activeBoundary: number | null,
): number {
  const touches =
    activeBoundary === 0
      ? rowIndex === 0
      : activeBoundary !== null && (rowIndex === activeBoundary - 1 || rowIndex === activeBoundary);
  if (!touches) return 0;
  return Math.max(
    0,
    Math.min(1, 1 - (rowHeight - ROW_REMOVE_THRESHOLD) / ROW_COLLAPSE_HINT_HEIGHT),
  );
}

const MIN_SIGMA = 14;
const MAX_SIGMA_CAP = 128;

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
 * becoming blank. The horizontal grid is always exactly one cell per device
 * pixel so the FFT input, rendered field, and status density share one axis.
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

  return { minSigmaPx, maxSigmaPx, sampleCellCount: Math.max(2, Math.ceil(numDevicePx)) };
}

export interface StackLayout {
  readonly newsHeight: number;
  readonly rowHeights: readonly number[];
}

/** Fit a news row and N signal rows exactly into the available canvas height. */
export function fitStackLayout(
  newsHeight: number,
  rowHeights: readonly number[],
  totalHeight: number,
): StackLayout {
  const total = Math.max(0, totalHeight);
  const count = rowHeights.length;
  if (count === 0) return { newsHeight: total, rowHeights: [] };

  // The news lane remains present, but signal rows intentionally have no
  // minimum. A row may be dragged all the way closed and removed on commit.
  const minNews = Math.min(MIN_NEWS_HEIGHT, total);
  const fittedNews = clamp(newsHeight, minNews, total);
  const signalSpace = Math.max(0, total - fittedNews);
  const weights = rowHeights.map(height => Math.max(0, height));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const fittedRows =
    weightSum > 0
      ? weights.map(weight => (signalSpace * weight) / weightSum)
      : rowHeights.map(() => signalSpace / count);

  return { newsHeight: fittedNews, rowHeights: fittedRows };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
