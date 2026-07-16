/** One shared, vertically-resizable news and market timeline. */

import type { EventSet, NewsEvent } from "../domain.ts";
import { TIMELINE_OVERLAY_METRICS } from "../ui/timelineOverlayMetrics.ts";
import type { EventQueryResult } from "../data/events/broker.ts";
import type { BrokerDemand, Subscription, ReadRequest, SignalView } from "../data/signal/broker.ts";
import type { MutableSample } from "../data/signal/sample.ts";
import { Interval } from "../core/interval.ts";
import { DataTransform } from "./transform.ts";
import { transformTouchInterval } from "./gesture.ts";
import { Plot } from "./plot.ts";
import { eventIndexAtOrBefore, eventIndexNearPoint } from "./hittest.ts";
import type { PaletteName } from "./ramp.ts";
import { kernelContext, type WaveletMode } from "./wavelet.ts";
import { DEFAULT_MIN_TICK_PX } from "./gfx/axis.ts";
import type { Frame } from "./gfx/context.ts";
import {
  DEFAULT_NEWS_HEIGHT,
  fitStackLayout,
  MIN_NEWS_HEIGHT,
  DEFAULT_SIGNAL_ROW_HEIGHT,
  RESIZE_HANDLE_RADIUS,
  COVERAGE_BAR_HEIGHT,
  heatmapScaleWindow,
} from "./gfx/layout.ts";

export type DataReader = (request: ReadRequest) => SignalView;
export type SampleAtReader = (time: number, out: MutableSample) => boolean;
export type DataSubscriber = (demand: BrokerDemand, onChange: () => void) => Subscription;
export type EventSource = (range: Interval) => EventQueryResult;

export interface SignalRow {
  readonly id: string;
  readonly read: DataReader;
  readonly readSampleAt: SampleAtReader;
  readonly subscribe: DataSubscriber;
  readonly palette: PaletteName;
  readonly waveletMode: WaveletMode;
  readonly verticalOffset: number;
  /** Preferred restored height. Used only when the row has no live height yet. */
  readonly height?: number;
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
  readonly initialTimeInterval: Interval;
  readonly initialPlayback?: TimelinePlayback;
  readonly initialNewsHeight?: number;
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
const ROW_COLLAPSE_HINT_HEIGHT = 72;
const ROW_REMOVE_THRESHOLD = 12;

export class Timeline {
  private readonly canvas: HTMLCanvasElement;
  private readonly plot: Plot;
  private readonly callbacks: TimelineCallbacks;
  private readonly eventSource: EventSource;
  private readonly feedColorOf: (feedId: string) => string;
  private readonly overlay: TimelineOverlaySink | undefined;
  private readonly config: TimelineConfig;
  private signalRows: readonly SignalRow[];
  private eventListeners: AbortController | null = null;
  // Mutable render-state mirrors. App state owns persistence; Timeline owns live gestures.
  private rowHeights: number[];
  private rowPalettes: PaletteName[];
  private rowWaveletModes: WaveletMode[];
  private rowVerticalOffsets: number[];
  private signalSubscriptions: Array<Subscription | undefined> = [];
  private subscribedDemands: Array<BrokerDemand | null> = [];
  private rowEvalTime: Float64Array[] = [];
  private rowHoverSamples: MutableSample[];
  private latestDpr = 1;
  private latestNumPx = 0;
  private restoreNewsHeightOnFirstRows: boolean;
  private layoutDirty = false;
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private state: TimelineState;
  private dragging = false;
  private resizingBoundary: number | null = null;
  private verticalPanRow: number | null = null;
  private dragPointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;
  private gestureStartX = 0;
  private gestureStartY = 0;
  private gestureMoved = false;
  private touchAId: number | null = null;
  private touchAX = 0;
  private touchAY = 0;
  private touchBId: number | null = null;
  private touchBX = 0;
  private touchBY = 0;
  private nowTimer: number | null = null;
  private pointerInside = false;
  private pointerPx = 0;
  private pointerPy = 0;
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
    this.canvas = opts.canvas;
    this.eventSource = opts.eventSource;
    this.feedColorOf = opts.feedColorOf;
    this.overlay = opts.overlay;
    this.callbacks = opts.callbacks ?? {};
    this.config = { ...DEFAULT_TIMELINE_CONFIG, ...opts.config };
    this.restoreNewsHeightOnFirstRows = opts.initialNewsHeight !== undefined;
    this.signalRows = opts.signalRows ?? [];
    this.rowHeights = this.signalRows.map((row) =>
      restoredRowHeight(row.height, DEFAULT_SIGNAL_ROW_HEIGHT),
    );
    this.rowPalettes = this.signalRows.map((row) => row.palette);
    this.rowWaveletModes = this.signalRows.map((row) => row.waveletMode);
    this.rowVerticalOffsets = this.signalRows.map((row) => row.verticalOffset);
    this.rowHoverSamples = this.signalRows.map(() => ({ t: Number.NaN, value: Number.NaN }));
    this.plot = new Plot({ canvas: opts.canvas, initialTimeInterval: opts.initialTimeInterval });
    this.state = {
      events: EMPTY_EVENTS,
      timeInterval: opts.initialTimeInterval,
      logGain: 22,
      hovered: null,
      newsHeight: restoredRowHeight(opts.initialNewsHeight, DEFAULT_NEWS_HEIGHT),
      playback: normalizePlayback(opts.initialPlayback),
    };
    this.bindEvents();
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas);
    }
    this.resize();
    this.reqDraw();
  }

  reqDraw(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.draw();
    });
  }

  setSignalRows(rows: readonly SignalRow[]): void {
    const previousRows = this.signalRows;
    const previousIndexById = new Map(previousRows.map((row, index) => [row.id, index]));
    const nextIds = new Set(rows.map((row) => row.id));
    const hadSignalRows = previousRows.length > 0;

    // A row identity owns its broker subscription and render scratch state.
    // Reordering/removing one row must not tear down every other row's demand.
    for (let index = 0; index < previousRows.length; index++) {
      if (!nextIds.has(previousRows[index]!.id)) this.signalSubscriptions[index]?.dispose();
    }

    const positiveHeights = this.rowHeights.filter((height) => height > 0);
    const fallback =
      positiveHeights.length > 0
        ? positiveHeights.reduce((sum, height) => sum + height, 0) / positiveHeights.length
        : DEFAULT_SIGNAL_ROW_HEIGHT;

    const previousHeights = this.rowHeights;
    const previousEvalTime = this.rowEvalTime;
    const previousHoverSamples = this.rowHoverSamples;
    const previousSubscriptions = this.signalSubscriptions;
    const previousDemands = this.subscribedDemands;

    this.signalRows = [...rows];
    this.rowHeights = rows.map((row) => {
      const previousIndex = previousIndexById.get(row.id);
      const previousHeight =
        previousIndex === undefined ? undefined : previousHeights[previousIndex];
      // Zero is valid only while a resize gesture is in progress. Once rows are
      // reconciled, every active row must have a positive recoverable height.
      return restoredRowHeight(previousHeight, restoredRowHeight(row.height, fallback));
    });
    this.rowPalettes = rows.map((row) => row.palette);
    this.rowWaveletModes = rows.map((row) => row.waveletMode);
    this.rowVerticalOffsets = rows.map((row) => row.verticalOffset);
    this.rowEvalTime = rows.map((row) => {
      const previousIndex = previousIndexById.get(row.id);
      return previousIndex === undefined
        ? new Float64Array(0)
        : (previousEvalTime[previousIndex] ?? new Float64Array(0));
    });
    this.rowHoverSamples = rows.map((row) => {
      const previousIndex = previousIndexById.get(row.id);
      return previousIndex === undefined
        ? { t: Number.NaN, value: Number.NaN }
        : (previousHoverSamples[previousIndex] ?? { t: Number.NaN, value: Number.NaN });
    });
    this.signalSubscriptions = rows.map((row) => {
      const previousIndex = previousIndexById.get(row.id);
      return previousIndex === undefined ? undefined : previousSubscriptions[previousIndex];
    });
    this.subscribedDemands = rows.map((row) => {
      const previousIndex = previousIndexById.get(row.id);
      return previousIndex === undefined ? null : (previousDemands[previousIndex] ?? null);
    });

    if (!hadSignalRows && rows.length > 0) {
      if (!this.restoreNewsHeightOnFirstRows) this.state.newsHeight = DEFAULT_NEWS_HEIGHT;
      this.restoreNewsHeightOnFirstRows = false;
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
    if (this.state.playback.mode === "following") {
      const playback = { mode: "following", anchor: this.captureNowAnchor(now) } as const;
      this.state.playback = playback;
      this.callbacks.onPlaybackChange?.(playback);
    }
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
    const index = this.signalRows.findIndex((row) => row.id === id);
    if (index < 0 || this.rowWaveletModes[index] === mode) return;
    this.rowWaveletModes[index] = mode;
    this.subscribedDemands[index] = null;
    this.reqDraw();
  }

  getPlayback(): TimelinePlayback {
    return this.state.playback;
  }

  getLayout(): TimelineLayout {
    return {
      newsHeight: this.state.newsHeight,
      rows: this.signalRows.map((row, index) => ({
        id: row.id,
        height: this.rowHeights[index]!,
        verticalOffset: this.rowVerticalOffsets[index]!,
      })),
    };
  }

  dispose(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.nowTimer !== null) clearTimeout(this.nowTimer);
    if (this.hoverClearTimer !== null) clearTimeout(this.hoverClearTimer);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.disposeSignalSubscriptions();
    this.unbindEvents();
  }

  private notifyViewportChange(): void {
    this.callbacks.onViewportChange?.(this.state.timeInterval, this.state.logGain);
  }

  private flushLayoutChange(removeCollapsedRows = false): void {
    if (!this.layoutDirty) return;
    this.layoutDirty = false;
    const collapsedRowIds = removeCollapsedRows
      ? this.signalRows
          .filter((_, index) => this.rowHeights[index]! <= ROW_REMOVE_THRESHOLD)
          .map((row) => row.id)
      : [];
    this.callbacks.onLayoutChange?.(this.getLayout(), collapsedRowIds);
  }

  private bindEvents(): void {
    if (this.eventListeners !== null) {
      throw new Error("Timeline events are already bound");
    }

    const controller = new AbortController();
    this.eventListeners = controller;
    const { signal } = controller;

    this.canvas.addEventListener("pointerdown", this.onPointerDown, { signal });

    window.addEventListener("pointermove", this.onPointerMove, { signal });
    window.addEventListener("pointerup", this.onPointerUp, { signal });
    window.addEventListener("pointercancel", this.onPointerCancel, { signal });

    this.canvas.addEventListener("wheel", this.onWheel, {
      passive: false,
      signal,
    });

    this.canvas.addEventListener("pointermove", this.onHoverMove, { signal });
    this.canvas.addEventListener("pointerleave", this.onHoverLeave, { signal });
    this.canvas.addEventListener("click", this.onClick, { signal });
    this.canvas.addEventListener("dblclick", this.onDoubleClick, { signal });
  }

  private unbindEvents(): void {
    this.eventListeners?.abort();
    this.eventListeners = null;
  }

  private resize(): void {
    const dpr = window.devicePixelRatio;
    this.plot.setDpr(dpr);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.fitLayout();
    this.reqDraw();
  }

  private fitLayout(): void {
    const fitted = fitStackLayout(this.state.newsHeight, this.rowHeights, this.plot.cssHeight);
    this.state.newsHeight = fitted.newsHeight;
    this.rowHeights = [...fitted.rowHeights];
  }

  private syncPriceSubscription(index: number, demand: BrokerDemand): void {
    const previous = this.subscribedDemands[index];
    if (
      previous !== null &&
      previous !== undefined &&
      previous.range.start === demand.range.start &&
      previous.range.end === demand.range.end &&
      previous.maxDeltaTMs === demand.maxDeltaTMs
    ) {
      return;
    }
    this.subscribedDemands[index] = demand;
    const existing = this.signalSubscriptions[index];
    if (existing !== undefined) {
      existing.update(demand);
      return;
    }
    const row = this.signalRows[index];
    if (row === undefined) return;
    this.signalSubscriptions[index] = row.subscribe(demand, () => this.reqDraw());
  }

  private disposeSignalSubscriptions(): void {
    for (const subscription of this.signalSubscriptions) subscription?.dispose();
    this.signalSubscriptions = [];
    this.subscribedDemands = [];
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
    for (let index = 0; index < this.signalRows.length; index++) {
      const row = this.signalRows[index]!;
      const rowHeight = this.rowHeights[index]!;
      const waveletMode = this.rowWaveletModes[index]!;
      this.overlay?.setRowTop(row.id, rowY);
      const rowTouchesActiveBoundary =
        this.resizingBoundary === 0
          ? index === 0
          : this.resizingBoundary !== null &&
            (index === this.resizingBoundary - 1 || index === this.resizingBoundary);
      const collapseProgress = rowTouchesActiveBoundary
        ? Math.max(0, Math.min(1, 1 - rowHeight / ROW_COLLAPSE_HINT_HEIGHT))
        : 0;
      this.overlay?.setRowCollapseProgress(row.id, collapseProgress);
      if (rowHeight <= COVERAGE_BAR_HEIGHT + 2) {
        rowY += rowHeight;
        continue;
      }
      const heatHeight = rowHeight - COVERAGE_BAR_HEIGHT;
      const scaleWindow = heatmapScaleWindow(
        numDevicePx,
        heatHeight,
        this.rowVerticalOffsets[index]!,
      );
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
      let evalTime = this.rowEvalTime[index];
      if (evalTime === undefined || evalTime.length < edgeCount) {
        evalTime = new Float64Array(edgeCount);
        this.rowEvalTime[index] = evalTime;
      }
      for (let sample = 0; sample < edgeCount; sample++) {
        evalTime[sample] = timeInterval.start + (sample - padLeft) * gridStepMs;
      }
      const evalView = evalTime.subarray(0, edgeCount) as Float64Array;
      const demand = {
        range: Interval.create(evalView[0]!, evalView[evalView.length - 1]!),
        maxDeltaTMs: gridStepMs,
      } satisfies BrokerDemand;
      this.syncPriceSubscription(index, demand);

      const result = row.read({ evalTime: evalView, maxSampleGapMs: gridStepMs });
      frame.heatmap(row.id).drawWaveletField(
        {
          evalTime: evalView,
          value: result.value,
          padLeft,
          padRight,
          visibleCells,
          revision: result.sampleRevision,
        },
        priceScale,
        waveletMode,
        rowY,
        heatHeight,
        scaleInterval,
        this.rowPalettes[index]!,
      );
      frame.resolution().draw(result.coverage, gridStepMs, rowY + heatHeight);
      rowY += rowHeight;
      frame.fillRectPx(0, rowY - 1, width, 1, "rgba(255,255,255,0.18)");
    }
    this.updateCrosshairOverlay();
    this.drawSignalHoverTooltips(frame);

    // The only time axis lives on the news/price boundary.
    frame.fillRectPx(0, this.state.newsHeight, width, 1, "rgba(255,255,255,0.3)");
    frame.drawTimeAxis(this.state.newsHeight, this.config.minTickPx);
    this.updateNowLine(wallNow);
    this.scheduleClock(timePerDevicePx / 2, wallNow);
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

    const x = Math.max(0, Math.min(width, this.pointerPx));
    const time =
      this.state.timeInterval.start +
      (x / width) * (this.state.timeInterval.end - this.state.timeInterval.start);
    this.overlay?.setCrosshair(true, x, time, width);
  }

  /** Shared visibility contract for the crosshair and all hover-owned labels. */
  private canShowHoverOverlay(): boolean {
    return (
      (this.pointerInside || this.eventTooltipHovered || this.crosshairPinned) &&
      !this.dragging &&
      this.resizingBoundary === null &&
      this.latestNumPx > 0 &&
      this.boundaryAt(this.pointerPy) === null
    );
  }

  private drawSignalHoverTooltips(frame: Frame): void {
    this.overlay?.hideSignalTooltips();
    if (!this.canShowHoverOverlay() || this.overlay === undefined) return;

    const x = Math.max(0, Math.min(frame.width, this.pointerPx));
    const hoverTime =
      this.state.timeInterval.start +
      (x / frame.width) * (this.state.timeInterval.end - this.state.timeInterval.start);
    let rowY = this.state.newsHeight;
    for (let index = 0; index < this.signalRows.length; index++) {
      const row = this.signalRows[index]!;
      const rowHeight = this.rowHeights[index]!;
      if (rowHeight <= COVERAGE_BAR_HEIGHT + 2) {
        rowY += rowHeight;
        continue;
      }
      const heatHeight = rowHeight - COVERAGE_BAR_HEIGHT;
      const sample = this.rowHoverSamples[index]!;
      const hasSample = row.readSampleAt(hoverTime, sample);
      const anchorX = !hasSample
        ? x
        : Math.max(0, Math.min(frame.width, frame.tx.timeToX(sample.t)));
      const text = !hasSample ? "loading…" : formatPrice(Math.exp(sample.value));
      positionSignalTooltip(frame, this.overlay, row.id, anchorX, rowY + heatHeight / 2, text);
      rowY += rowHeight;
    }
  }

  public setSignalRowPalette(id: string, palette: PaletteName): void {
    const index = this.signalRows.findIndex((row) => row.id === id);
    if (index < 0 || this.rowPalettes[index] === palette) return;
    this.rowPalettes[index] = palette;
    this.reqDraw();
  }

  private boundaryAt(y: number): number | null {
    if (this.signalRows.length === 0) return null;
    let boundaryY = this.state.newsHeight;
    if (Math.abs(y - boundaryY) <= RESIZE_HANDLE_RADIUS) return 0;
    for (let index = 0; index < this.rowHeights.length - 1; index++) {
      boundaryY += this.rowHeights[index]!;
      if (Math.abs(y - boundaryY) <= RESIZE_HANDLE_RADIUS) return index + 1;
    }
    return null;
  }

  private moveBoundary(boundary: number, delta: number): void {
    if (this.rowHeights.length === 0 || delta === 0) return;
    this.layoutDirty = true;
    if (boundary === 0) {
      const pair = this.state.newsHeight + this.rowHeights[0]!;
      const minNews = Math.min(MIN_NEWS_HEIGHT, pair);
      const newsHeight = Math.max(minNews, Math.min(pair, this.state.newsHeight + delta));
      this.rowHeights[0] = pair - newsHeight;
      this.state.newsHeight = newsHeight;
      return;
    }
    const left = boundary - 1;
    const right = boundary;
    const pair = this.rowHeights[left]! + this.rowHeights[right]!;
    const leftHeight = Math.max(0, Math.min(pair, this.rowHeights[left]! + delta));
    this.rowHeights[left] = leftHeight;
    this.rowHeights[right] = pair - leftHeight;
  }

  private rowAt(y: number): number | null {
    let rowY = this.state.newsHeight;
    for (let index = 0; index < this.rowHeights.length; index++) {
      const nextY = rowY + this.rowHeights[index]!;
      if (y >= rowY && y < nextY - COVERAGE_BAR_HEIGHT) return index;
      rowY = nextY;
    }
    return null;
  }

  private panRowVertically(index: number | null, delta: number): void {
    if (index === null || delta === 0) return;
    const next = this.rowVerticalOffsets[index]! + delta;
    if (next === this.rowVerticalOffsets[index]) return;
    this.rowVerticalOffsets[index] = next;
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

  private scheduleClock(timePerDevicePx: number, renderedNow: number): void {
    if (this.nowTimer !== null) clearTimeout(this.nowTimer);
    let delayMs = this.state.timeInterval.start - renderedNow;

    if (this.state.playback.mode === "following") delayMs = timePerDevicePx;
    else if (renderedNow > this.state.timeInterval.end) return;

    this.nowTimer = setTimeout(
      () => {
        this.nowTimer = null;
        this.reqDraw();
      },
      Math.max(delayMs, timePerDevicePx),
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

  private onPointerDown = (event: PointerEvent): void => {
    this.updatePointer(event);
    this.crosshairPinned = false;
    this.reqDraw();
    if (event.pointerType === "touch") {
      this.onTouchDown(event);
      return;
    }

    this.gestureStartX = event.clientX;
    this.gestureStartY = event.clientY;
    this.gestureMoved = false;
    this.dragPointerId = event.pointerId;
    const boundary = this.boundaryAt(this.pointerPy);
    if (boundary !== null) {
      this.resizingBoundary = boundary;
      this.verticalPanRow = null;
      this.dragging = false;
      this.lastY = this.pointerPy;
      if (this.clearHover()) this.reqDraw();
      this.canvas.style.cursor = "ns-resize";
      this.canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }
    this.dragging = true;
    this.lastX = event.clientX;
    this.lastY = this.pointerPy;
    this.verticalPanRow = this.rowAt(this.pointerPy);
    this.canvas.setPointerCapture?.(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      this.onTouchMove(event);
      return;
    }
    if (event.pointerId !== this.dragPointerId) return;
    if (this.resizingBoundary !== null) {
      this.updatePointer(event);
      const y = this.pointerPy;
      this.moveBoundary(this.resizingBoundary, y - this.lastY);
      this.lastY = y;
      this.markGestureMoved(event.clientX, event.clientY);
      this.reqDraw();
      return;
    }
    if (!this.dragging) return;
    this.updatePointer(event);
    const dx = event.clientX - this.lastX;
    const dy = this.pointerPy - this.lastY;
    this.lastX = event.clientX;
    this.lastY = this.pointerPy;
    this.markGestureMoved(event.clientX, event.clientY);
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    const span = this.state.timeInterval.end - this.state.timeInterval.start;
    if (dx !== 0) {
      this.panTimeInterval(Interval.pan(this.state.timeInterval, -(dx / rect.width) * span));
    }
    this.panRowVertically(this.verticalPanRow, dy);
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      this.onTouchEnd(event);
      return;
    }
    if (event.pointerId !== this.dragPointerId) return;
    this.dragging = false;
    this.resizingBoundary = null;
    this.flushLayoutChange(true);
    this.verticalPanRow = null;
    this.dragPointerId = null;
    if (this.canvas.hasPointerCapture?.(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    this.updatePointer(event);
    this.reqDraw();
  };

  private onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      this.onTouchEnd(event, true);
      return;
    }
    if (event.pointerId !== this.dragPointerId) return;
    this.dragPointerId = null;
    this.dragging = false;
    this.resizingBoundary = null;
    this.flushLayoutChange(true);
    this.verticalPanRow = null;
    this.reqDraw();
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.updatePointer(event);
    const rect = this.canvas.getBoundingClientRect();
    const cssWidth = this.plot.cssWidth;
    const cssHeight = this.plot.cssHeight;
    if (cssWidth <= 0 || rect.width <= 0) return;
    const px = (event.clientX - rect.left) * (cssWidth / rect.width);
    let dy = event.deltaY;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) dy *= this.config.wheelLineHeight;
    else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) dy *= cssHeight;
    const span = this.state.timeInterval.end - this.state.timeInterval.start;
    const dt = (this.config.timeScrollSensitivity * span * event.deltaX) / cssWidth;
    if (dt !== 0) {
      this.panTimeInterval(Interval.pan(this.state.timeInterval, dt));
    }
    if (event.shiftKey) {
      this.setPriceScale(this.state.logGain - dy * this.config.wheelSensitivity);
      return;
    }
    const tx = new DataTransform(
      this.state.timeInterval,
      Interval.create(0, cssWidth),
      Interval.create(0, cssHeight),
    );
    const factor = Math.exp(-dy * this.config.wheelSensitivity);
    this.panTimeInterval(Interval.zoom(this.state.timeInterval, tx.xToTime(px), factor));
  };

  private onHoverMove = (event: PointerEvent): void => {
    this.updatePointer(event);
    if (this.pointerInside) this.cancelScheduledHoverClear();
    const boundary = this.boundaryAt(this.pointerPy);
    this.canvas.style.cursor =
      boundary !== null
        ? "ns-resize"
        : this.clickableEventIndexAtCurrentTransform() !== null
          ? "pointer"
          : "";
    if (this.dragging || this.resizingBoundary !== null) return;
    this.updateHoverAtCurrentTransform();
    this.reqDraw();
  };

  private onHoverLeave = (): void => {
    this.pointerInside = false;
    this.scheduleHoverClear();
  };

  private onClick = (event: MouseEvent): void => {
    if (this.gestureMoved) {
      this.gestureMoved = false;
      return;
    }
    this.updatePointer(event);
    const clickedEventIndex = this.clickableEventIndexAtCurrentTransform();
    if (this.updateHoverAtCurrentTransform()) this.reqDraw();
    this.reqDraw();
    if (clickedEventIndex !== null) {
      const clicked = this.eventAt(clickedEventIndex);
      window.open(clicked.link, "_blank", "noopener,noreferrer");
    }
  };

  private onDoubleClick = (event: MouseEvent): void => {
    event.preventDefault();
    this.updatePointer(event);
    // A marker activation wins over the chart-level navigation gesture.
    if (this.clickableEventIndexAtCurrentTransform() !== null) return;
    this.crosshairPinned = false;
    this.followNowAtRightEdge();
  };

  private onTouchDown(event: PointerEvent): void {
    if (this.touchAId === null) {
      this.touchAId = event.pointerId;
      this.touchAX = event.clientX;
      this.touchAY = event.clientY;
      this.gestureStartX = event.clientX;
      this.gestureStartY = event.clientY;
      this.gestureMoved = false;
      const boundary = this.boundaryAt(this.pointerPy);
      if (boundary !== null) {
        this.resizingBoundary = boundary;
        this.verticalPanRow = null;
        this.lastY = this.pointerPy;
        this.canvas.style.cursor = "ns-resize";
      } else {
        this.resizingBoundary = null;
        this.verticalPanRow = this.rowAt(this.pointerPy);
        this.lastY = this.pointerPy;
      }
      this.dragging = true;
    } else if (this.touchBId === null && event.pointerId !== this.touchAId) {
      this.touchBId = event.pointerId;
      this.touchBX = event.clientX;
      this.touchBY = event.clientY;
      this.resizingBoundary = null;
      this.gestureMoved = true;
      if (this.clearHover()) this.reqDraw();
    }
    this.canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  private onTouchMove(event: PointerEvent): void {
    const movingA = event.pointerId === this.touchAId;
    const movingB = event.pointerId === this.touchBId;
    if (!movingA && !movingB) return;

    const previousAX = this.touchAX;
    const previousAY = this.touchAY;
    const previousBX = this.touchBX;
    const previousBY = this.touchBY;
    if (movingA) {
      this.touchAX = event.clientX;
      this.touchAY = event.clientY;
    } else {
      this.touchBX = event.clientX;
      this.touchBY = event.clientY;
    }

    this.updatePointer(event);
    if (this.touchBId !== null) {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width > 0) {
        const previousCenterX = (previousAX + previousBX) / 2 - rect.left;
        const currentCenterX = (this.touchAX + this.touchBX) / 2 - rect.left;
        const previousCenterY = (previousAY + previousBY) / 2;
        const currentCenterY = (this.touchAY + this.touchBY) / 2;
        const previousDistance = Math.hypot(previousBX - previousAX, previousBY - previousAY);
        const currentDistance = Math.hypot(
          this.touchBX - this.touchAX,
          this.touchBY - this.touchAY,
        );
        const transformedInterval = transformTouchInterval(
          this.state.timeInterval,
          rect.width,
          previousCenterX,
          currentCenterX,
          previousDistance,
          currentDistance,
        );
        if (Math.abs(currentCenterX - previousCenterX) >= 0.5) {
          this.panTimeInterval(transformedInterval);
        } else {
          this.setTimeInterval(transformedInterval);
        }
        if (rect.height > 0) {
          this.panRowVertically(
            this.verticalPanRow,
            (currentCenterY - previousCenterY) * (this.plot.cssHeight / rect.height),
          );
        }
      }
      event.preventDefault();
      return;
    }

    if (this.resizingBoundary !== null) {
      const y = this.pointerPy;
      this.moveBoundary(this.resizingBoundary, y - this.lastY);
      this.lastY = y;
      this.markGestureMoved(event.clientX, event.clientY);
      this.reqDraw();
      event.preventDefault();
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    if (rect.width > 0) {
      const dx = this.touchAX - previousAX;
      const span = this.state.timeInterval.end - this.state.timeInterval.start;
      if (dx !== 0) {
        this.panTimeInterval(Interval.pan(this.state.timeInterval, -(dx / rect.width) * span));
      }
      if (rect.height > 0) {
        this.panRowVertically(
          this.verticalPanRow,
          (this.touchAY - previousAY) * (this.plot.cssHeight / rect.height),
        );
      }
    }
    this.markGestureMoved(event.clientX, event.clientY);
    event.preventDefault();
  }

  private onTouchEnd(event: PointerEvent, cancelled = false): void {
    this.updatePointer(event);
    if (event.pointerId === this.touchAId) {
      if (this.touchBId !== null) {
        this.touchAId = this.touchBId;
        this.touchAX = this.touchBX;
        this.touchAY = this.touchBY;
        this.touchBId = null;
      } else {
        this.touchAId = null;
      }
    } else if (event.pointerId === this.touchBId) {
      this.touchBId = null;
    } else {
      return;
    }

    if (this.canvas.hasPointerCapture?.(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    this.resizingBoundary = null;
    if (this.touchAId === null) {
      this.dragging = false;
      this.verticalPanRow = null;
      this.crosshairPinned = !cancelled && this.pointerInside;
      this.canvas.style.cursor = "";
    } else {
      this.dragging = true;
      this.gestureStartX = this.touchAX;
      this.gestureStartY = this.touchAY;
    }
    this.flushLayoutChange(this.touchAId === null);
    if (cancelled) {
      this.pointerInside = false;
      this.clearHover();
    } else if (this.touchAId === null) {
      this.updateHoverAtCurrentTransform();
    }
    this.reqDraw();
  }

  private scheduleHoverClear(): void {
    if (
      this.pointerInside ||
      this.eventTooltipHovered ||
      this.crosshairPinned ||
      this.dragging ||
      this.resizingBoundary !== null ||
      this.hoverClearTimer !== null
    ) {
      return;
    }

    this.hoverClearTimer = window.setTimeout(() => {
      this.hoverClearTimer = null;
      if (
        this.pointerInside ||
        this.eventTooltipHovered ||
        this.crosshairPinned ||
        this.dragging ||
        this.resizingBoundary !== null
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

  private markGestureMoved(clientX: number, clientY: number): void {
    if (
      !this.gestureMoved &&
      Math.hypot(clientX - this.gestureStartX, clientY - this.gestureStartY) >= 5
    ) {
      this.gestureMoved = true;
    }
  }

  private eventAt(index: number): NewsEvent {
    const event = this.state.events.events[index];
    if (event === undefined) throw new Error(`Event index out of range: ${index}`);
    return event;
  }

  private updatePointer(event: Pick<PointerEvent, "clientX" | "clientY">): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      this.pointerInside = false;
      return;
    }
    this.pointerInside =
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
    this.pointerPx = (event.clientX - rect.left) * (this.plot.cssWidth / rect.width);
    this.pointerPy = (event.clientY - rect.top) * (this.plot.cssHeight / rect.height);
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

  private clickableEventIndexAtCurrentTransform(): number | null {
    const width = this.plot.cssWidth;
    const height = this.plot.cssHeight;
    if (!(width > 0) || !(height > 0) || !this.pointerInside) return null;
    const tx = new DataTransform(
      this.state.timeInterval,
      Interval.create(0, width),
      Interval.create(0, height),
    );
    return eventIndexNearPoint(
      this.state.events,
      tx,
      this.pointerPx,
      this.pointerPy,
      this.state.newsHeight / 2,
    );
  }

  private updateHover(tx: DataTransform, eventY: number, width: number, height: number): boolean {
    const previous = this.state.hovered;
    const index =
      (this.pointerInside || this.eventTooltipHovered || this.crosshairPinned) &&
      !this.dragging &&
      this.resizingBoundary === null &&
      this.boundaryAt(this.pointerPy) === null
        ? eventIndexAtOrBefore(this.state.events, tx, this.pointerPx)
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

function restoredRowHeight(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizePlayback(playback: TimelinePlayback | undefined): TimelinePlayback {
  if (playback?.mode !== "following") {
    return playback ?? { mode: "following", anchor: DEFAULT_NOW_ANCHOR };
  }
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
  const connectorX = fitsLeft ? x + width : x;
  const y = Math.max(margin, Math.min(frame.height - height - margin, anchorY - height / 2));

  ctx.strokeStyle = "rgba(226, 232, 240, 0.58)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(anchorX, anchorY);
  ctx.lineTo(connectorX, anchorY);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(anchorX, anchorY, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = "#f8fafc";
  ctx.fill();
  ctx.restore();

  overlay.setSignalTooltip(id, text, x, y, width, height);
}
