import { Interval } from "../../core/interval.ts";
import type { BrokerDemand, ReadRequest, SignalView } from "../../data/index.ts";
import { kernelContext, type WaveletMode } from "../wavelet.ts";
import type { PaletteName } from "../ramp.ts";
import type { Frame } from "./context.ts";
import { heatmapScaleWindow, signalRowLayout, type SignalRowLayout } from "./layout.ts";

export interface SignalRowDrawOptions {
  readonly verticalOffset: number;
  readonly logGain: number;
  readonly waveletMode: WaveletMode;
  readonly palette: PaletteName;
  readonly wallNow: number;
  readonly read: (demand: BrokerDemand, request: ReadRequest) => SignalView;
}

export interface SignalRowLayer extends SignalRowLayout {
  /** Draw the heatmap, status strip, and separator. True when a retry is visible. */
  draw(options: SignalRowDrawOptions): boolean;
}

interface SignalRowResources {
  evalTime: Float64Array;
}

const RESOURCE_BY_CONTEXT = new WeakMap<
  CanvasRenderingContext2D,
  Map<string, SignalRowResources>
>();

export const SignalRows = {
  create(frame: Frame, rowId: string, top: number, height: number): SignalRowLayer {
    return new SignalRowImpl(frame, rowId, top, height);
  },
};

class SignalRowImpl implements SignalRowLayer {
  readonly top: number;
  readonly height: number;
  readonly heatmapTop: number;
  readonly heatmapHeight: number;
  readonly heatmapCenter: number;
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
    this.heatmapCenter = layout.heatmapCenter;
    this.drawable = layout.drawable;
  }

  draw(options: SignalRowDrawOptions): boolean {
    if (!this.drawable) return false;

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

    const demand = {
      range: Interval.create(evalTime[0]!, evalTime[edgeCount - 1]!),
      maxDeltaTMs: gridStepMs,
    } satisfies BrokerDemand;
    const view = options.read(demand, { evalTime });
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
    const hasVisibleRetry = frame
      .statusBar()
      .draw(density, view.requests, this.top, options.wallNow);
    frame.fillRectPx(0, this.top + this.height - 1, frame.width, 1, "rgba(255,255,255,0.18)");
    return hasVisibleRetry;
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
    resources = { evalTime: new Float64Array(0) };
    rows.set(rowId, resources);
  }
  return resources;
}
