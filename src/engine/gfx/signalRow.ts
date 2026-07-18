import { Interval } from "../../core/interval.ts";
import type { SignalView } from "../../data/index.ts";
import { kernelContext, type WaveletMode } from "../wavelet.ts";
import type { PaletteName } from "../ramp.ts";
import type { Frame } from "./context.ts";
import {
  COVERAGE_BAR_HEIGHT,
  heatmapScaleWindow,
  signalRowLayout,
  type SignalRowLayout,
} from "./layout.ts";
import { TIMELINE_OVERLAY_METRICS } from "../../ui/timelineOverlayMetrics.ts";

export interface SignalRowDrawOptions {
  readonly verticalOffset: number;
  readonly logGain: number;
  readonly waveletMode: WaveletMode;
  readonly palette: PaletteName;
  readonly read: (evalTime: Float64Array) => SignalView;
}

export interface SignalRowLayer extends SignalRowLayout {
  /** Draw the heatmap, sample-density strip, and separator. */
  draw(options: SignalRowDrawOptions): void;
  /** Draw the canvas anchor/connector and resolve the matching DOM tooltip rectangle. */
  drawTooltip(anchorX: number, cursorX: number, text: string): SignalTooltipPlacement;
}

export interface SignalRowStack {
  /** Return the next row at the current stack position, then advance by its height. */
  next(rowId: string, height: number): SignalRowLayer;
}

export interface SignalTooltipPlacement {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface SignalRowResources {
  evalTime: Float64Array;
  readonly tooltip: MutableSignalTooltipPlacement;
}

type MutableSignalTooltipPlacement = { -readonly [K in keyof SignalTooltipPlacement]: number };

const RESOURCE_BY_CONTEXT = new WeakMap<
  CanvasRenderingContext2D,
  Map<string, SignalRowResources>
>();

export const SignalRows = {
  create(frame: Frame, rowId: string, top: number, height: number): SignalRowLayer {
    return new SignalRowImpl(frame, rowId, top, height);
  },
  stack(frame: Frame, top: number): SignalRowStack {
    return new SignalRowStackImpl(frame, top);
  },
};

class SignalRowStackImpl implements SignalRowStack {
  constructor(
    private readonly frame: Frame,
    private top: number,
  ) {}

  next(rowId: string, height: number): SignalRowLayer {
    const row = SignalRows.create(this.frame, rowId, this.top, height);
    this.top += height;
    return row;
  }
}

class SignalRowImpl implements SignalRowLayer {
  readonly top: number;
  readonly height: number;
  readonly heatmapTop: number;
  readonly heatmapHeight: number;
  readonly tooltipPosition: number;
  readonly drawable: boolean;

  constructor(
    private readonly frame: Frame,
    private readonly rowId: string,
    top: number,
    height: number,
  ) {
    const layout = signalRowLayout(top, height);
    this.top = layout.top;
    this.height = layout.height;
    this.heatmapTop = layout.heatmapTop;
    this.heatmapHeight = layout.heatmapHeight;
    this.tooltipPosition = layout.tooltipPosition;
    this.drawable = layout.drawable;
  }

  draw(options: SignalRowDrawOptions): void {
    if (!this.drawable) return;

    const { frame } = this;
    const resources = signalRowResources(frame.ctx, this.rowId);
    const visibleInterval = frame.tx.timeDomain;
    const numDevicePx = frame.deviceWidth;
    const timePerDevicePx = Interval.span(visibleInterval) / numDevicePx;
    const scaleWindow = heatmapScaleWindow(numDevicePx, this.heatmapHeight, options.verticalOffset);
    const visibleCells = scaleWindow.sampleCellCount;
    const gridStepMs = Interval.span(visibleInterval) / visibleCells;
    const scaleInterval = Interval.create(
      scaleWindow.minSigmaPx * timePerDevicePx,
      scaleWindow.maxSigmaPx * timePerDevicePx,
    );
    const context = kernelContext(options.waveletMode, scaleInterval.end / gridStepMs);
    const padLeft = context.leftCells;
    const padRight = context.rightCells;
    const edgeCount = padLeft + visibleCells + padRight + 1;

    if (resources.evalTime.length !== edgeCount) resources.evalTime = new Float64Array(edgeCount);
    const evalTime = resources.evalTime;
    for (let sample = 0; sample < edgeCount; sample++) {
      evalTime[sample] = visibleInterval.start + (sample - padLeft) * gridStepMs;
    }

    const view = options.read(evalTime);
    const density = frame
      .heatmap(this.rowId)
      .drawWaveletField(
        { evalTime, view, padLeft, padRight, visibleCells },
        options.logGain,
        options.waveletMode,
        this.heatmapTop,
        this.heatmapHeight,
        scaleInterval,
        options.palette,
      );
    frame.statusBar().draw(density, view.reports, this.top + this.height - COVERAGE_BAR_HEIGHT);
    frame.fillRectPx(0, this.top + this.height - 1, frame.width, 1, "rgba(255,255,255,0.18)");
  }

  drawTooltip(anchorX: number, cursorX: number, text: string): SignalTooltipPlacement {
    const { frame } = this;
    const ctx = frame.ctx;
    const metrics = TIMELINE_OVERLAY_METRICS.signalTooltip;
    const placement = signalRowResources(ctx, this.rowId).tooltip;
    ctx.save();
    ctx.font = metrics.font;
    placement.width =
      Math.ceil(ctx.measureText(text).width) + metrics.paddingXPx * 2 + metrics.borderWidthPx * 2;
    placement.height = metrics.heightPx;
    const fitsLeft = anchorX - metrics.gapPx - placement.width >= metrics.marginPx;
    placement.x = fitsLeft
      ? anchorX - metrics.gapPx - placement.width
      : Math.max(
          metrics.marginPx,
          Math.min(frame.width - placement.width - metrics.marginPx, anchorX + metrics.gapPx),
        );
    placement.y = Math.max(
      metrics.marginPx,
      Math.min(
        frame.height - placement.height - metrics.marginPx,
        this.tooltipPosition - placement.height / 2,
      ),
    );

    ctx.strokeStyle = "rgba(226, 232, 240, 0.58)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(anchorX, this.tooltipPosition);
    ctx.lineTo(cursorX, this.tooltipPosition);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(anchorX, this.tooltipPosition, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = "#f8fafc";
    ctx.fill();
    ctx.restore();
    return placement;
  }
}

function signalRowResources(ctx: CanvasRenderingContext2D, rowId: string): SignalRowResources {
  let rows = RESOURCE_BY_CONTEXT.get(ctx);
  if (rows === undefined) {
    rows = new Map();
    RESOURCE_BY_CONTEXT.set(ctx, rows);
  }
  let resources = rows.get(rowId);
  if (resources === undefined) {
    resources = { evalTime: new Float64Array(0), tooltip: { x: 0, y: 0, width: 0, height: 0 } };
    rows.set(rowId, resources);
  }
  return resources;
}
