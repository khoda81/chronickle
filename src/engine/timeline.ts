/** One shared, vertically-resizable news and market timeline. */

import type { EventSet, NewsEvent } from "../domain.ts";
import { TIMELINE_OVERLAY_METRICS } from "../ui/timelineOverlayMetrics.ts";
import type { EventQueryResult } from "../data/events/broker.ts";
import type { Subscription, ReadRequest, SignalView } from "../data/signal/broker.ts";
import type { MutableSample } from "../data/signal/sample.ts";
import { Interval } from "../core/interval.ts";
import { DataTransform } from "./transform.ts";
import { transformTouchInterval, type GestureInputKind } from "./gesture.ts";
import { TimelineGestureController, type GestureTarget } from "./timelineGestureController.ts";
import type { CanvasPoint, MutableCanvasSize } from "./coordinates.ts";
import { Plot } from "./plot.ts";
import { eventIndexAtOrBefore, eventIndexNearPoint } from "./hittest.ts";
import type { PaletteName } from "./ramp.ts";
import { kernelContext, type WaveletMode } from "./wavelet.ts";
import { DEFAULT_MIN_TICK_PX } from "./gfx/axis.ts";
import type { Frame } from "./gfx/context.ts";
import {
  fitStackLayout,
  MIN_NEWS_HEIGHT,
  RESIZE_HANDLE_RADIUS,
  COVERAGE_BAR_HEIGHT,
  heatmapScaleWindow,
} from "./gfx/layout.ts";
import { BrokerDemand } from "../data/index.ts";

export type DataReader = (request: ReadRequest) => SignalView;
export type SampleAtReader = (time: number, out: MutableSample) => boolean;
export type DataSubscriber = (
  demand: BrokerDemand,
  onChange: () => void,
  signal: AbortSignal,
) => Subscription;
export type EventSource = (range: Interval) => EventQueryResult;

export interface SignalRow {
  readonly id: string;
  readonly read: DataReader;
  readonly readSampleAt: SampleAtReader;
  readonly subscribe: DataSubscriber;
  readonly palette: PaletteName;
  readonly waveletMode: WaveletMode;
  readonly verticalOffset: number;
  readonly height: number;
}

interface ActiveSignalSubscription {
  demand: BrokerDemand;
  readonly subscription: Subscription;
  readonly controller: AbortController;
}

interface SignalRowRuntime {
  readonly row: SignalRow;
  height: number;
  palette: PaletteName;
  waveletMode: WaveletMode;
  verticalOffset: number;
  evalTime: Float64Array;
  readonly hoverSample: MutableSample;
  subscription: ActiveSignalSubscription | null;
}

export interface HoverInfo {
  readonly index: number;
  readonly title: string;
  readonly link: string;
  readonly feedId: string;
  readonly summary: string;
  readonly t: number;
}

type MutableHoverInfo = { -readonly [Key in keyof HoverInfo]: HoverInfo[Key] };

export type TimelinePlayback =
  { readonly mode: "following"; readonly anchor: number } | { readonly mode: "paused" };

export interface TimelineLayout {
  readonly newsHeight: number;
  readonly rows: readonly {
    readonly id: string;
    readonly height: number;
    readonly verticalOffset: number;
  }[];
}

export interface TimelineOverlaySink {
  setNowLine(visible: boolean, x: number, width: number, stroke: string): void;
  setCrosshair(visible: boolean, x: number, time: number, viewportWidth: number): void;
  setEventTooltipAnchor(
    visible: boolean,
    x: number,
    y: number,
    viewportWidth: number,
    viewportHeight: number,
  ): void;
  setRowTop(id: string, top: number): void;
  setRowCollapseProgress(id: string, progress: number): void;
  hideSignalTooltips(): void;
  setSignalTooltip(
    id: string,
    text: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void;
}

export interface TimelineCallbacks {
  onHover?: (event: HoverInfo | null) => void;
  onViewportChange?: (viewport: Interval, priceScale: number) => void;
  onPlaybackChange?: (playback: TimelinePlayback) => void;
  onLayoutChange?: (layout: TimelineLayout, collapsedRowIds: readonly string[]) => void;
}

export interface TimelineOptions {
  readonly canvas: HTMLCanvasElement;
  readonly signal: AbortSignal;
  readonly initialTimeInterval: Interval;
  readonly initialPlayback: TimelinePlayback;
  readonly initialNewsHeight: number;
  readonly signalRows: readonly SignalRow[];
  readonly eventSource: EventSource;
  readonly feedColorOf: (feedId: string) => string;
  readonly overlay?: TimelineOverlaySink;
  readonly callbacks?: TimelineCallbacks;
  readonly config?: Partial<TimelineConfig>;
}

interface TimelineState {
  events: EventSet;
  timeInterval: Interval;
  logGain: number;
  hovered: number | null;
  newsHeight: number;
  playback: TimelinePlayback;
}

export interface TimelineConfig {
  readonly wheelLineHeight: number;
  readonly wheelSensitivity: number;
  readonly timeScrollSensitivity: number;
  readonly nowWidth: number;
  readonly nowStroke: string;
  readonly minTickPx: number;
}

const DEFAULT_TIMELINE_CONFIG: TimelineConfig = {
  wheelLineHeight: 16,
  wheelSensitivity: 0.003,
  timeScrollSensitivity: 3,
  nowWidth: 2,
  nowStroke: "rgba(255, 255, 255, 0.55)",
  minTickPx: DEFAULT_MIN_TICK_PX,
};

const EMPTY_EVENTS: EventSet = { events: [] };
const DEFAULT_NOW_ANCHOR = 0.85;
const RIGHT_EDGE_NOW_ANCHOR = 1;
const ROW_COLLAPSE_HINT_HEIGHT = 128;
const ROW_REMOVE_THRESHOLD = 64;

export class Timeline {
  private readonly canvas: HTMLCanvasElement;
  private readonly plot: Plot;
  private readonly callbacks: TimelineCallbacks;
  private readonly eventSource: EventSource;
  private readonly feedColorOf: (feedId: string) => string;
  private readonly overlay: TimelineOverlaySink | undefined;
  private readonly config: TimelineConfig;
  private readonly signal: AbortSignal;
  private readonly canvasSize: MutableCanvasSize = { width: 0, height: 0 };
  private readonly gestures: TimelineGestureController;
  // App state owns persistence; Timeline owns the live mutable row runtime.
  private rows: SignalRowRuntime[];
  private latestDpr = 1;
  private latestNumPx = 0;
  private pendingInitialNewsHeight: number | null;
  private layoutDirty = false;
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private state: TimelineState;
  private nowTimer: number | null = null;
  private crosshairPinned = false;
  private eventTooltipHovered = false;
  private hoverClearTimer: number | null = null;
  private notifiedHoverIndex: number | null = null;
  private notifiedHoverT = Number.NaN;
  private notifiedHoverTitle = "";
  private notifiedHoverLink = "";
  private notifiedHoverFeedId = "";
  private notifiedHoverSummary = "";
  private readonly hoverInfo: MutableHoverInfo = {
    index: -1,
    title: "",
    link: "",
    feedId: "",
    summary: "",
    t: Number.NaN,
  };

  constructor(opts: TimelineOptions) {
    opts.signal.throwIfAborted();
    this.canvas = opts.canvas;
    this.signal = opts.signal;
    this.eventSource = opts.eventSource;
    this.feedColorOf = opts.feedColorOf;
    this.overlay = opts.overlay;
    this.callbacks = opts.callbacks ?? {};
    this.config = { ...DEFAULT_TIMELINE_CONFIG, ...opts.config };
    this.rows = opts.signalRows.map(row => createSignalRowRuntime(row, row.height));
    this.pendingInitialNewsHeight = this.rows.length === 0 ? opts.initialNewsHeight : null;
    this.plot = new Plot({ canvas: opts.canvas, initialTimeInterval: opts.initialTimeInterval });
    this.state = {
      events: EMPTY_EVENTS,
      timeInterval: opts.initialTimeInterval,
      logGain: 22,
      hovered: null,
      newsHeight: opts.initialNewsHeight,
      playback: normalizePlayback(opts.initialPlayback),
    };
    this.gestures = new TimelineGestureController({
      canvas: this.canvas,
      viewport: this.canvasSize,
      wheelLineHeight: this.config.wheelLineHeight,
      signal: this.signal,
      host: {
        targetAt: point => this.gestureTargetAt(point),
        gestureStarted: () => this.onGestureStarted(),
        gestureEnded: (input, cancelled, finished, pointerInside) =>
          this.onGestureEnded(input, cancelled, finished, pointerInside),
        panTimeByPixels: (deltaX, viewportWidth) => this.panTimeByPixels(deltaX, viewportWidth),
        panRow: (row, deltaY) => this.panRowVertically(row, deltaY),
        resizeBoundary: (index, deltaY) => this.resizeBoundaryBy(index, deltaY),
        pinchTime: (
          viewportWidth,
          previousCenterX,
          currentCenterX,
          previousDistance,
          currentDistance,
        ) =>
          this.pinchTime(
            viewportWidth,
            previousCenterX,
            currentCenterX,
            previousDistance,
            currentDistance,
          ),
        wheel: (point, deltaX, deltaY, shiftKey) =>
          this.onGestureWheel(point, deltaX, deltaY, shiftKey),
        hoverMoved: (point, pointerInside) => this.onGestureHoverMove(point, pointerInside),
        pointerLeft: () => this.onGesturePointerLeave(),
        tap: point => this.onGestureTap(point),
        doubleTap: point => this.onGestureDoubleTap(point),
      },
    });

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas);
    }
    this.resize();
    this.reqDraw();
    this.signal.addEventListener("abort", this.close, { once: true });
  }

  reqDraw(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.draw();
    });
  }

  setSignalRows(rows: readonly SignalRow[]): void {
    const previousById = new Map(this.rows.map(runtime => [runtime.row.id, runtime]));
    const nextIds = new Set(rows.map(row => row.id));
    const hadSignalRows = this.rows.length > 0;

    // A row identity owns its broker subscription and render scratch state.
    // Reordering/removing one row must not tear down every other row's demand.
    for (const runtime of this.rows) {
      if (!nextIds.has(runtime.row.id)) runtime.subscription?.controller.abort();
    }

    this.rows = rows.map(row => {
      const previous = previousById.get(row.id);
      // Zero is valid only while a resize gesture is in progress. Once rows are
      // reconciled, every active row must have a positive recoverable height.
      const height =
        previous === undefined ? row.height : restoredRowHeight(previous.height, row.height);
      return createSignalRowRuntime(row, height, previous);
    });

    if (!hadSignalRows && rows.length > 0) {
      if (this.pendingInitialNewsHeight !== null) {
        this.state.newsHeight = this.pendingInitialNewsHeight;
        this.pendingInitialNewsHeight = null;
      }
    }
    this.fitLayout();
    this.state.hovered = null;
    this.reqDraw();
  }

  refreshEvents(): void {
    const { events } = this.eventSource(this.state.timeInterval);
    this.state.events = { events };
    this.state.hovered = null;
    this.reqDraw();
  }

  setTimeInterval(range: Interval): void {
    this.applyTimeInterval(range, true);
  }

  private applyTimeInterval(range: Interval, notify: boolean): void {
    this.state.timeInterval = range;
    this.plot.setTimeInterval(range);
    if (notify) this.notifyViewportChange();
    this.reqDraw();
  }

  private setPlayback(playback: TimelinePlayback): void {
    if (samePlayback(playback, this.state.playback)) return;
    this.state.playback = playback;
    this.callbacks.onPlaybackChange?.(playback);
    this.reqDraw();
  }

  private captureNowAnchor(now: number): number {
    const span = this.state.timeInterval.end - this.state.timeInterval.start;
    if (!(span > 0)) return DEFAULT_NOW_ANCHOR;
    return (now - this.state.timeInterval.start) / span;
  }

  private panTimeInterval(range: Interval, now = Date.now()): void {
    this.state.timeInterval = range;
    this.plot.setTimeInterval(range);
    const playback = { mode: "paused", anchor: this.captureNowAnchor(now) } as const;
    this.setPlayback(playback);
    this.notifyViewportChange();
    this.reqDraw();
  }

  getTimeInterval(): Interval {
    return this.state.timeInterval;
  }

  setPriceScale(scale: number): void {
    this.state.logGain = scale;
    this.notifyViewportChange();
    this.reqDraw();
  }

  getPriceScale(): number {
    return this.state.logGain;
  }

  setSignalRowWaveletMode(id: string, mode: WaveletMode): void {
    const runtime = this.rows.find(runtime => runtime.row.id === id);
    if (runtime === undefined || runtime.waveletMode === mode) return;
    runtime.waveletMode = mode;
    runtime.subscription?.controller.abort();
    runtime.subscription = null;
    this.reqDraw();
  }

  getPlayback(): TimelinePlayback {
    return this.state.playback;
  }

  getLayout(): TimelineLayout {
    return {
      newsHeight: this.state.newsHeight,
      rows: this.rows.map(runtime => ({
        id: runtime.row.id,
        height: runtime.height,
        verticalOffset: runtime.verticalOffset,
      })),
    };
  }

  private close = (): void => {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.nowTimer !== null) clearTimeout(this.nowTimer);
    if (this.hoverClearTimer !== null) clearTimeout(this.hoverClearTimer);
    this.rafId = null;
    this.nowTimer = null;
    this.hoverClearTimer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.disposeSignalSubscriptions();
  };

  private notifyViewportChange(): void {
    this.callbacks.onViewportChange?.(this.state.timeInterval, this.state.logGain);
  }

  private flushLayoutChange(removeCollapsedRows = false): void {
    if (!this.layoutDirty) return;
    this.layoutDirty = false;
    const collapsedRowIds = removeCollapsedRows
      ? this.rows
        .filter(runtime => runtime.height <= ROW_REMOVE_THRESHOLD)
        .map(runtime => runtime.row.id)
      : [];
    this.callbacks.onLayoutChange?.(this.getLayout(), collapsedRowIds);
  }

  private resize(): void {
    const dpr = window.devicePixelRatio;
    this.plot.setDpr(dpr);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.canvasSize.width = this.plot.cssWidth;
    this.canvasSize.height = this.plot.cssHeight;
    this.fitLayout();
    this.reqDraw();
  }

  private fitLayout(): void {
    const fitted = fitStackLayout(
      this.state.newsHeight,
      this.rows.map(runtime => runtime.height),
      this.plot.cssHeight,
    );
    this.state.newsHeight = fitted.newsHeight;
    for (let index = 0; index < this.rows.length; index++) {
      this.rows[index]!.height = fitted.rowHeights[index]!;
    }
  }

  private syncPriceSubscription(index: number, demand: BrokerDemand): void {
    const runtime = this.rows[index];
    if (runtime === undefined) return;
    const active = runtime.subscription;
    const previous = active?.demand;
    if (
      previous !== undefined &&
      previous.range.start === demand.range.start &&
      previous.range.end === demand.range.end &&
      previous.maxDeltaTMs === demand.maxDeltaTMs
    ) {
      return;
    }
    if (active !== null) {
      active.demand = demand;
      active.subscription.update(demand);
      return;
    }
    const controller = new AbortController();
    runtime.subscription = {
      demand,
      controller,
      subscription: runtime.row.subscribe(demand, () => this.reqDraw(), controller.signal),
    };
  }

  private disposeSignalSubscriptions(): void {
    for (const runtime of this.rows) {
      runtime.subscription?.controller.abort();
      runtime.subscription = null;
    }
  }

  private draw = (): void => {
    if (!(this.plot.cssWidth > 0) || !(this.plot.cssHeight > 0)) return;

    const dpr = window.devicePixelRatio;
    const numDevicePx = Math.ceil(this.plot.cssWidth * dpr);
    if (numDevicePx <= 0) return;
    const wallNow = Date.now();
    this.advanceFollowNow(wallNow);

    using frame = this.plot.beginFrame();
    const { width, height } = frame;
    const { logGain: priceScale, timeInterval } = this.state;
    frame.fillRectPx(0, 0, width, height, "#05070d");

    const timePerDevicePx = (timeInterval.end - timeInterval.start) / numDevicePx;
    this.latestDpr = frame.dpr;
    this.latestNumPx = numDevicePx;

    const eventResult = this.eventSource(timeInterval);
    this.state.events = { events: eventResult.events };
    const eventY = this.state.newsHeight / 2;
    this.updateHover(frame.tx, eventY, width, height);
    frame.text("NEWS", 8, 9, "10px ui-monospace, monospace", "#94a3b8", "left", "top");
    frame.events().drawRow(this.state.events, this.feedColorOf, this.state.hovered, eventY);

    let rowY = this.state.newsHeight;
    let hasVisibleRetry = false;
    for (let index = 0; index < this.rows.length; index++) {
      const runtime = this.rows[index]!;
      const { row, height: rowHeight, waveletMode } = runtime;
      this.overlay?.setRowTop(row.id, rowY + COVERAGE_BAR_HEIGHT);
      const activeBoundary = this.gestures.activeBoundary;
      const rowTouchesActiveBoundary =
        activeBoundary === 0
          ? index === 0
          : activeBoundary !== null && (index === activeBoundary - 1 || index === activeBoundary);
      const collapseProgressRaw = 1 - (rowHeight - ROW_REMOVE_THRESHOLD) / ROW_COLLAPSE_HINT_HEIGHT;
      const collapseProgress = rowTouchesActiveBoundary
        ? Math.max(0, Math.min(1, collapseProgressRaw))
        : 0;
      this.overlay?.setRowCollapseProgress(row.id, collapseProgress);
      if (rowHeight <= COVERAGE_BAR_HEIGHT + 2) {
        rowY += rowHeight;
        continue;
      }
      const heatHeight = rowHeight - COVERAGE_BAR_HEIGHT;
      const scaleWindow = heatmapScaleWindow(numDevicePx, heatHeight, runtime.verticalOffset);
      const visibleCells = scaleWindow.sampleCellCount;
      const gridStepMs = (timeInterval.end - timeInterval.start) / visibleCells;
      const scaleInterval = Interval.create(
        scaleWindow.minSigmaPx * timePerDevicePx,
        scaleWindow.maxSigmaPx * timePerDevicePx,
      );
      const context = kernelContext(waveletMode, scaleInterval.end / gridStepMs);
      const padLeft = context.leftCells;
      const padRight = context.rightCells;
      const edgeCount = padLeft + visibleCells + padRight + 1;
      let evalTime = runtime.evalTime;
      if (evalTime.length < edgeCount) {
        evalTime = new Float64Array(edgeCount);
        runtime.evalTime = evalTime;
      }
      for (let sample = 0; sample < edgeCount; sample++) {
        evalTime[sample] = timeInterval.start + (sample - padLeft) * gridStepMs;
      }

      evalTime = evalTime.subarray(0, edgeCount) as Float64Array;
      const readTimeRange = Interval.create(evalTime[0]!, evalTime[evalTime.length - 1]!);
      const demand = { range: readTimeRange, maxDeltaTMs: gridStepMs } satisfies BrokerDemand;
      this.syncPriceSubscription(index, demand);

      const view = row.read({ evalTime });

      const sampleDensity = frame
        .heatmap(row.id)
        .drawWaveletField(
          { evalTime, view, padLeft, padRight, visibleCells },
          priceScale,
          waveletMode,
          rowY + COVERAGE_BAR_HEIGHT,
          heatHeight,
          scaleInterval,
          runtime.palette,
        );

      hasVisibleRetry =
        frame.statusBar().draw(sampleDensity, view.requests, rowY, wallNow) || hasVisibleRetry;

      rowY += rowHeight;
      frame.fillRectPx(0, rowY - 1, width, 1, "rgba(255,255,255,0.18)");
    }
    this.updateCrosshairOverlay();
    this.drawSignalHoverTooltips(frame);

    // The only time axis lives on the news/price boundary.
    frame.fillRectPx(0, this.state.newsHeight, width, 1, "rgba(255,255,255,0.3)");
    frame.drawTimeAxis(this.state.newsHeight, this.config.minTickPx);
    this.updateNowLine(wallNow);
    this.scheduleClock(timePerDevicePx / 2, wallNow, hasVisibleRetry);
  };

  private advanceFollowNow(now: number): void {
    if (this.state.playback.mode !== "following") return;
    const span = this.state.timeInterval.end - this.state.timeInterval.start;
    const anchor = this.state.playback.anchor;
    const min = now - span * anchor;
    const range = Interval.create(min, anchor === RIGHT_EDGE_NOW_ANCHOR ? now : min + span);
    this.state.timeInterval = range;
    this.plot.setTimeInterval(range);
  }

  private updateCrosshairOverlay(): void {
    const width = this.plot.cssWidth;
    if (!this.canShowHoverOverlay() || !(width > 0)) {
      this.overlay?.setCrosshair(false, 0, Number.NaN, width);
      return;
    }

    const x = Math.max(0, Math.min(width, this.gestures.pointer.x));
    const time =
      this.state.timeInterval.start +
      (x / width) * (this.state.timeInterval.end - this.state.timeInterval.start);
    this.overlay?.setCrosshair(true, x, time, width);
  }

  /** Shared visibility contract for the crosshair and all hover-owned labels. */
  private canShowHoverOverlay(): boolean {
    return (
      (this.gestures.pointerInside || this.eventTooltipHovered || this.crosshairPinned) &&
      !this.gestures.active &&
      this.latestNumPx > 0 &&
      this.boundaryAt(this.gestures.pointer.y) === null
    );
  }

  private drawSignalHoverTooltips(frame: Frame): void {
    this.overlay?.hideSignalTooltips();
    if (!this.canShowHoverOverlay() || this.overlay === undefined) return;

    const x = Math.max(0, Math.min(frame.width, this.gestures.pointer.x));
    const hoverTime =
      this.state.timeInterval.start +
      (x / frame.width) * (this.state.timeInterval.end - this.state.timeInterval.start);
    let rowY = this.state.newsHeight;
    for (const runtime of this.rows) {
      const { row, height: rowHeight } = runtime;
      if (rowHeight <= COVERAGE_BAR_HEIGHT + 2) {
        rowY += rowHeight;
        continue;
      }
      const heatHeight = rowHeight - COVERAGE_BAR_HEIGHT;
      const sample = runtime.hoverSample;
      const hasSample = row.readSampleAt(hoverTime, sample);
      const anchorX = hasSample ? frame.tx.timeToX(sample.t) : x;
      const text = !hasSample ? "loading…" : formatPrice(Math.exp(sample.value));
      positionSignalTooltip(
        frame,
        this.overlay,
        row.id,
        anchorX,
        rowY + COVERAGE_BAR_HEIGHT + heatHeight / 2,
        x,
        text,
      );
      rowY += rowHeight;
    }
  }

  public setSignalRowPalette(id: string, palette: PaletteName): void {
    const runtime = this.rows.find(runtime => runtime.row.id === id);
    if (runtime === undefined || runtime.palette === palette) return;
    runtime.palette = palette;
    this.reqDraw();
  }

  private boundaryAt(y: number): number | null {
    if (this.rows.length === 0) return null;
    let boundaryY = this.state.newsHeight;
    if (Math.abs(y - boundaryY) <= RESIZE_HANDLE_RADIUS) return 0;
    for (let index = 0; index < this.rows.length - 1; index++) {
      boundaryY += this.rows[index]!.height;
      if (Math.abs(y - boundaryY) <= RESIZE_HANDLE_RADIUS) return index + 1;
    }
    return null;
  }

  private moveBoundary(boundary: number, delta: number): void {
    if (this.rows.length === 0 || delta === 0) return;
    this.layoutDirty = true;
    if (boundary === 0) {
      const pair = this.state.newsHeight + this.rows[0]!.height;
      const minNews = Math.min(MIN_NEWS_HEIGHT, pair);
      const newsHeight = Math.max(minNews, Math.min(pair, this.state.newsHeight + delta));
      this.rows[0]!.height = pair - newsHeight;
      this.state.newsHeight = newsHeight;
      return;
    }
    const left = boundary - 1;
    const right = boundary;
    const pair = this.rows[left]!.height + this.rows[right]!.height;
    const leftHeight = Math.max(0, Math.min(pair, this.rows[left]!.height + delta));
    this.rows[left]!.height = leftHeight;
    this.rows[right]!.height = pair - leftHeight;
  }

  private rowAt(y: number): number | null {
    let rowY = this.state.newsHeight;
    for (let index = 0; index < this.rows.length; index++) {
      const nextY = rowY + this.rows[index]!.height;
      if (y >= rowY + COVERAGE_BAR_HEIGHT && y < nextY) return index;
      rowY = nextY;
    }
    return null;
  }

  private panRowVertically(index: number | null, delta: number): void {
    if (index === null || delta === 0) return;
    const runtime = index === null ? undefined : this.rows[index];
    if (runtime === undefined) return;
    const next = runtime.verticalOffset + delta;
    if (next === runtime.verticalOffset) return;
    runtime.verticalOffset = next;
    this.layoutDirty = true;
    this.reqDraw();
  }

  private updateNowLine(now: number): void {
    const { timeInterval } = this.state;
    if (now < timeInterval.start || now > timeInterval.end) {
      this.overlay?.setNowLine(false, 0, 0, this.config.nowStroke);
      return;
    }

    const x =
      ((now - timeInterval.start) / (timeInterval.end - timeInterval.start)) * this.plot.cssWidth;
    const deviceWidth = Math.max(1, Math.round(this.config.nowWidth));
    const deviceCanvasWidth = Math.round(this.plot.cssWidth * this.latestDpr);
    const deviceLeft = Math.max(
      0,
      Math.min(deviceCanvasWidth - deviceWidth, Math.round(x * this.latestDpr - deviceWidth / 2)),
    );
    this.overlay?.setNowLine(
      true,
      deviceLeft / this.latestDpr,
      deviceWidth / this.latestDpr,
      this.config.nowStroke,
    );
  }

  private scheduleClock(
    timePerDevicePx: number,
    renderedNow: number,
    hasVisibleRetry: boolean,
  ): void {
    if (this.nowTimer !== null) clearTimeout(this.nowTimer);
    let delayMs = this.state.timeInterval.start - renderedNow;

    if (this.state.playback.mode === "following") delayMs = timePerDevicePx;
    else if (renderedNow > this.state.timeInterval.end) delayMs = Number.POSITIVE_INFINITY;

    // A broker status update redraws immediately when a retry starts or ends.
    // This clock keeps the visible countdown current without a needless 60 fps
    // loop: the human-scale label changes materially at most once per second.
    delayMs = Math.max(delayMs, timePerDevicePx);
    if (hasVisibleRetry) delayMs = Math.min(delayMs, 1_000);
    if (!Number.isFinite(delayMs)) return;

    this.nowTimer = setTimeout(
      () => {
        this.nowTimer = null;
        this.reqDraw();
      },
      Math.max(delayMs, 16),
    );
  }

  /**
   * Retain the current hover while the pointer is over the event card.
   *
   * Canvas `pointerleave` fires before the tooltip receives `pointerenter`, so
   * hover clearing is deferred by one task and cancelled when the card takes
   * ownership. This keeps the crosshair fixed while links remain selectable.
   */
  public setEventTooltipHovered(hovered: boolean): void {
    this.eventTooltipHovered = hovered;
    if (hovered) {
      this.cancelScheduledHoverClear();
      this.reqDraw();
      return;
    }
    if (this.state.hovered === null) {
      this.cancelScheduledHoverClear();
      return;
    }
    this.scheduleHoverClear();
  }

  public togglePlayback(): void {
    if (this.state.playback.mode === "following") {
      this.setPlayback({ mode: "paused" });
      return;
    }

    this.setPlayback({ mode: "following", anchor: this.captureNowAnchor(Date.now()) });
  }

  private followNowAtRightEdge(): void {
    const now = Date.now();
    const span = this.state.timeInterval.end - this.state.timeInterval.start;
    if (!(span > 0)) return;

    this.state.playback = { mode: "following", anchor: RIGHT_EDGE_NOW_ANCHOR };
    this.applyTimeInterval(Interval.create(now - span, now), true);
    this.callbacks.onPlaybackChange?.(this.state.playback);
  }

  private gestureTargetAt(point: CanvasPoint): GestureTarget {
    const boundary = this.boundaryAt(point.y);
    return boundary === null
      ? { kind: "viewport", row: this.rowAt(point.y) }
      : { kind: "boundary", index: boundary };
  }

  private onGestureStarted(): void {
    this.crosshairPinned = false;
    this.clearHover();
    this.reqDraw();
  }

  private onGestureEnded(
    input: GestureInputKind,
    cancelled: boolean,
    finished: boolean,
    pointerInside: boolean,
  ): void {
    this.flushLayoutChange(finished);
    if (input === "touch" && finished) {
      this.crosshairPinned = !cancelled && pointerInside;
    }
    if (cancelled) this.clearHover();
    else if (input === "touch" && finished) this.updateHoverAtCurrentTransform();
    if (finished && !pointerInside) this.scheduleHoverClear();
    this.reqDraw();
  }

  private panTimeByPixels(deltaX: number, viewportWidth: number): void {
    if (deltaX === 0 || !(viewportWidth > 0)) return;
    const span = this.state.timeInterval.end - this.state.timeInterval.start;
    this.panTimeInterval(Interval.pan(this.state.timeInterval, -(deltaX / viewportWidth) * span));
  }

  private resizeBoundaryBy(index: number, deltaY: number): void {
    this.moveBoundary(index, deltaY);
    this.reqDraw();
  }

  private pinchTime(
    viewportWidth: number,
    previousCenterX: number,
    currentCenterX: number,
    previousDistance: number,
    currentDistance: number,
  ): void {
    const transformed = transformTouchInterval(
      this.state.timeInterval,
      viewportWidth,
      previousCenterX,
      currentCenterX,
      previousDistance,
      currentDistance,
    );
    if (Math.abs(currentCenterX - previousCenterX) >= 0.5) {
      this.panTimeInterval(transformed);
    } else {
      this.setTimeInterval(transformed);
    }
  }

  private onGestureWheel(
    point: CanvasPoint,
    deltaX: number,
    deltaY: number,
    shiftKey: boolean,
  ): void {
    const cssWidth = this.plot.cssWidth;
    if (!(cssWidth > 0)) return;
    const span = this.state.timeInterval.end - this.state.timeInterval.start;
    const dt = (this.config.timeScrollSensitivity * span * deltaX) / cssWidth;
    if (dt !== 0) {
      this.panTimeInterval(Interval.pan(this.state.timeInterval, dt));
    }
    if (shiftKey) {
      this.setPriceScale(this.state.logGain - deltaY * this.config.wheelSensitivity);
      return;
    }
    if (deltaY === 0) return;
    const anchorTime =
      this.state.timeInterval.start +
      (point.x / cssWidth) * (this.state.timeInterval.end - this.state.timeInterval.start);
    const factor = Math.exp(-deltaY * this.config.wheelSensitivity);
    this.panTimeInterval(Interval.zoom(this.state.timeInterval, anchorTime, factor));
  }

  private onGestureHoverMove(point: CanvasPoint, pointerInside: boolean): void {
    if (pointerInside) this.cancelScheduledHoverClear();
    const boundary = this.boundaryAt(point.y);
    this.canvas.style.cursor =
      boundary !== null
        ? "ns-resize"
        : this.clickableEventIndexAtCurrentTransform(point) !== null
          ? "pointer"
          : "";
    this.updateHoverAtCurrentTransform();
    this.reqDraw();
  }

  private onGesturePointerLeave(): void {
    this.scheduleHoverClear();
  }

  private onGestureTap(point: CanvasPoint): void {
    const clickedEventIndex = this.clickableEventIndexAtCurrentTransform(point);
    if (this.updateHoverAtCurrentTransform()) this.reqDraw();
    this.reqDraw();
    if (clickedEventIndex !== null) {
      const clicked = this.eventAt(clickedEventIndex);
      window.open(clicked.link, "_blank", "noopener,noreferrer");
    }
  }

  private onGestureDoubleTap(point: CanvasPoint): void {
    // A marker activation wins over the chart-level navigation gesture.
    if (this.clickableEventIndexAtCurrentTransform(point) !== null) return;
    this.crosshairPinned = false;
    this.followNowAtRightEdge();
  }

  private scheduleHoverClear(): void {
    if (
      this.gestures.pointerInside ||
      this.eventTooltipHovered ||
      this.crosshairPinned ||
      this.gestures.active ||
      this.hoverClearTimer !== null
    ) {
      return;
    }

    this.hoverClearTimer = window.setTimeout(() => {
      this.hoverClearTimer = null;
      if (
        this.gestures.pointerInside ||
        this.eventTooltipHovered ||
        this.crosshairPinned ||
        this.gestures.active
      ) {
        return;
      }
      this.clearHover();
      this.reqDraw();
    }, 0);
  }

  private cancelScheduledHoverClear(): void {
    if (this.hoverClearTimer === null) return;
    clearTimeout(this.hoverClearTimer);
    this.hoverClearTimer = null;
  }

  private eventAt(index: number): NewsEvent {
    const event = this.state.events.events[index];
    if (event === undefined) throw new Error(`Event index out of range: ${index}`);
    return event;
  }

  private updateHoverAtCurrentTransform(): boolean {
    const width = this.plot.cssWidth;
    const height = this.plot.cssHeight;
    if (!(width > 0) || !(height > 0)) return this.clearHover();
    const tx = new DataTransform(
      this.state.timeInterval,
      Interval.create(0, width),
      Interval.create(0, height),
    );
    return this.updateHover(tx, this.state.newsHeight / 2, width, height);
  }

  private clickableEventIndexAtCurrentTransform(
    point: CanvasPoint = this.gestures.pointer,
  ): number | null {
    const width = this.plot.cssWidth;
    const height = this.plot.cssHeight;
    if (!(width > 0) || !(height > 0) || !this.gestures.pointerInside) return null;
    const tx = new DataTransform(
      this.state.timeInterval,
      Interval.create(0, width),
      Interval.create(0, height),
    );
    return eventIndexNearPoint(this.state.events, tx, point, this.state.newsHeight / 2);
  }

  private updateHover(tx: DataTransform, eventY: number, width: number, height: number): boolean {
    const previous = this.state.hovered;
    const point = this.gestures.pointer;
    const index =
      (this.gestures.pointerInside || this.eventTooltipHovered || this.crosshairPinned) &&
        !this.gestures.active &&
        this.boundaryAt(point.y) === null
        ? eventIndexAtOrBefore(this.state.events, tx, point.x)
        : null;
    this.state.hovered = index;
    if (index === null) {
      this.clearHover();
      return previous !== null;
    }

    const event = this.eventAt(index);
    const anchorX = Math.max(0, Math.min(width, tx.timeToX(event.t)));
    this.overlay?.setEventTooltipAnchor(true, anchorX, eventY, width, height);

    const contentChanged =
      index !== this.notifiedHoverIndex ||
      event.t !== this.notifiedHoverT ||
      event.title !== this.notifiedHoverTitle ||
      event.link !== this.notifiedHoverLink ||
      event.feedId !== this.notifiedHoverFeedId ||
      event.summary !== this.notifiedHoverSummary;
    if (!contentChanged || this.callbacks.onHover === undefined) return previous !== index;

    this.notifiedHoverIndex = index;
    this.notifiedHoverT = event.t;
    this.notifiedHoverTitle = event.title;
    this.notifiedHoverLink = event.link;
    this.notifiedHoverFeedId = event.feedId;
    this.notifiedHoverSummary = event.summary;
    const info = this.hoverInfo;
    info.index = index;
    info.title = event.title;
    info.link = event.link;
    info.feedId = event.feedId;
    info.summary = event.summary;
    info.t = event.t;
    this.callbacks.onHover(info);
    return previous !== index;
  }

  private clearHover(): boolean {
    const visualChanged = this.state.hovered !== null;
    this.state.hovered = null;
    this.overlay?.setEventTooltipAnchor(false, 0, 0, 0, 0);
    if (this.notifiedHoverIndex === null) return visualChanged;
    this.notifiedHoverIndex = null;
    this.notifiedHoverT = Number.NaN;
    this.notifiedHoverTitle = "";
    this.notifiedHoverLink = "";
    this.notifiedHoverFeedId = "";
    this.notifiedHoverSummary = "";
    this.callbacks.onHover?.(null);
    return visualChanged;
  }
}

function createSignalRowRuntime(
  row: SignalRow,
  height: number,
  previous?: SignalRowRuntime,
): SignalRowRuntime {
  return {
    row,
    height,
    palette: row.palette,
    waveletMode: row.waveletMode,
    verticalOffset: row.verticalOffset,
    evalTime: previous?.evalTime ?? new Float64Array(0),
    hoverSample: previous?.hoverSample ?? { t: Number.NaN, value: Number.NaN },
    subscription: previous?.subscription ?? null,
  };
}

function restoredRowHeight(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizePlayback(playback: TimelinePlayback): TimelinePlayback {
  if (playback.mode !== "following") return playback;
  const anchor = Number.isFinite(playback.anchor) ? playback.anchor : DEFAULT_NOW_ANCHOR;
  return { mode: "following", anchor: Math.max(0, Math.min(1, anchor)) };
}

function samePlayback(a: TimelinePlayback, b: TimelinePlayback): boolean {
  return (
    a.mode === b.mode && (a.mode === "paused" || (b.mode === "following" && a.anchor === b.anchor))
  );
}

const PRICE_FORMAT = new Intl.NumberFormat(undefined, {
  maximumSignificantDigits: 9,
  useGrouping: true,
});

function formatPrice(price: number): string {
  if (!(price > 0) || !Number.isFinite(price)) return "—";
  return PRICE_FORMAT.format(price);
}

function positionSignalTooltip(
  frame: Frame,
  overlay: TimelineOverlaySink,
  id: string,
  anchorX: number,
  anchorY: number,
  cursorX: number,
  text: string,
): void {
  const ctx = frame.ctx;
  const metrics = TIMELINE_OVERLAY_METRICS.signalTooltip;
  ctx.save();
  ctx.font = metrics.font;
  const width =
    Math.ceil(ctx.measureText(text).width) + metrics.paddingXPx * 2 + metrics.borderWidthPx * 2;
  const height = metrics.heightPx;
  const gap = metrics.gapPx;
  const margin = metrics.marginPx;
  const fitsLeft = anchorX - gap - width >= margin;
  const x = fitsLeft
    ? anchorX - gap - width
    : Math.max(margin, Math.min(frame.width - width - margin, anchorX + gap));

  const y = Math.max(margin, Math.min(frame.height - height - margin, anchorY - height / 2));

  ctx.strokeStyle = "rgba(226, 232, 240, 0.58)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(anchorX, anchorY);
  ctx.lineTo(cursorX, anchorY);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(anchorX, anchorY, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = "#f8fafc";
  ctx.fill();
  ctx.restore();

  overlay.setSignalTooltip(id, text, x, y, width, height);
}
