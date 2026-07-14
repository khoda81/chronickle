/** One shared, vertically-resizable news and market timeline. */

import type { EventSet, NewsEvent } from "../domain.ts";
import type { EventQueryResult } from "../data/events/broker.ts";
import type { QueryResult } from "../data/price/broker.ts";
import { Range } from "./range.ts";
import { DataTransform } from "./transform.ts";
import { Plot } from "./plot.ts";
import { hitTestEvent } from "./hittest.ts";
import { setRampPalette, type PaletteName } from "./ramp.ts";
import { kernelContext, type WaveletMode } from "./wavelet.ts";
import { DEFAULT_MIN_TICK_PX } from "./gfx/axis.ts";
import type { Frame } from "./gfx/context.ts";
import {
  DEFAULT_NEWS_HEIGHT,
  fitStackLayout,
  MIN_NEWS_HEIGHT,
  MIN_PRICE_ROW_HEIGHT,
  RESIZE_HANDLE_RADIUS,
  RESOLUTION_BAR_HEIGHT,
  maxSigmaFor,
} from "./gfx/layout.ts";

export type DataSource = (evalTime: Float64Array, maxDeltaTMs: number) => QueryResult;
export type EventSource = (range: Range) => EventQueryResult;

export interface PriceRow {
  readonly id: string;
  readonly label: string;
  readonly dataSource: DataSource;
}

export interface HoverInfo {
  readonly index: number;
  readonly title: string;
  readonly link: string;
  readonly feedId: string;
  readonly summary: string;
  readonly t: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

type MutableHoverInfo = { -readonly [Key in keyof HoverInfo]: HoverInfo[Key] };
type MutableEventSet = { -readonly [Key in keyof EventSet]: EventSet[Key] };

export interface TimelineCallbacks {
  onHover?: (event: HoverInfo | null) => void;
  onViewportChange?: (viewport: { min: number; max: number }, priceScale: number) => void;
}

export interface TimelineOptions {
  readonly canvas: HTMLCanvasElement;
  readonly initialTimeRange: Range;
  readonly priceRows?: readonly PriceRow[];
  readonly eventSource: EventSource;
  readonly feedColorOf: (feedId: string) => string;
  readonly callbacks?: TimelineCallbacks;
  readonly config?: Partial<TimelineConfig>;
}

export interface TimelineConfig {
  readonly wheelLineHeight: number;
  readonly wheelSensitivity: number;
  readonly timeScrollSensitivity: number;
  readonly nowWidth: number;
  readonly nowStroke: string;
  readonly minTickPx: number;
}

export const DEFAULT_TIMELINE_CONFIG: TimelineConfig = {
  wheelLineHeight: 16,
  wheelSensitivity: 0.003,
  timeScrollSensitivity: 3,
  nowWidth: 2,
  nowStroke: "rgba(255, 255, 255, 0.55)",
  minTickPx: DEFAULT_MIN_TICK_PX,
};

interface PricePane {
  readonly row: PriceRow;
  /** Relative layout preference. Actual CSS-pixel height is derived. */
  weight: number;
}

type PointerState = { readonly kind: "outside" } | { kind: "inside"; x: number; y: number };

type Gesture =
  | { readonly kind: "idle" }
  | { kind: "panning"; readonly pointerId: number; lastClientX: number }
  | { kind: "resizing"; readonly pointerId: number; readonly boundary: number; lastY: number };

const OUTSIDE_POINTER: PointerState = { kind: "outside" };
const IDLE_GESTURE: Gesture = { kind: "idle" };

export class Timeline {
  private readonly canvas: HTMLCanvasElement;
  private readonly plot: Plot;
  private readonly callbacks: TimelineCallbacks;
  private readonly eventSource: EventSource;
  private readonly feedColorOf: (feedId: string) => string;
  private readonly config: TimelineConfig;

  private timeRange: Range;
  private priceScale = 22;
  private waveletMode: WaveletMode = "centered";

  private panes: PricePane[];
  private newsWeight = DEFAULT_NEWS_HEIGHT;
  private layoutRevision = 0;
  private resolvedLayoutRevision = -1;
  private resolvedLayoutHeight = Number.NaN;
  private resolvedNewsHeight = 0;
  private resolvedRowHeights = new Float64Array(0);

  private pointer: PointerState = OUTSIDE_POINTER;
  private gesture: Gesture = IDLE_GESTURE;
  /** Render cache only: the event highlighted by the most recent frame. */
  private paintedHover: NewsEvent | null = null;
  /** Render cache only: the exact event snapshot currently painted on canvas. */
  private readonly paintedEvents: MutableEventSet = { events: [] };

  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private evalTime = new Float64Array(0);
  private readonly nowLine: HTMLDivElement;
  private nowTimer: number | null = null;
  private readonly hoverInfo: MutableHoverInfo = {
    index: -1,
    title: "",
    link: "",
    feedId: "",
    summary: "",
    t: Number.NaN,
    anchorX: Number.NaN,
    anchorY: Number.NaN,
    viewportWidth: Number.NaN,
    viewportHeight: Number.NaN,
  };

  constructor(opts: TimelineOptions) {
    this.canvas = opts.canvas;
    this.timeRange = opts.initialTimeRange;
    this.eventSource = opts.eventSource;
    this.feedColorOf = opts.feedColorOf;
    this.callbacks = opts.callbacks ?? {};
    this.config = { ...DEFAULT_TIMELINE_CONFIG, ...opts.config };
    const initialRows = opts.priceRows ?? [];
    this.panes = [];
    this.plot = new Plot({ canvas: opts.canvas });

    const parent = this.canvas.parentElement;
    if (parent === null) throw new Error("Timeline canvas must have a parent element");
    this.nowLine = document.createElement("div");
    this.nowLine.className = "timeline-now-line";
    this.nowLine.style.width = `${this.config.nowWidth}px`;
    this.nowLine.style.background = this.config.nowStroke;
    parent.append(this.nowLine);

    this.bindEvents();
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas);
    }
    this.resize();
    if (initialRows.length > 0) this.setPriceRows(initialRows);
    this.reqDraw();
  }

  reqDraw(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.draw();
    });
  }

  setPriceRows(rows: readonly PriceRow[]): void {
    this.resolveLayout();
    const oldHeight = new Map<string, number>();
    for (let index = 0; index < this.panes.length; index++) {
      oldHeight.set(this.panes[index]!.row.id, this.resolvedRowHeights[index]!);
    }
    const fallback =
      this.panes.length === 0
        ? MIN_PRICE_ROW_HEIGHT
        : this.resolvedRowHeights.reduce((sum, height) => sum + height, 0) / this.panes.length;

    const hadRows = this.panes.length > 0;
    if (!hadRows && rows.length > 0) {
      const total = this.plot.cssHeight;
      const minNews = Math.min(MIN_NEWS_HEIGHT, total / (rows.length + 1));
      const minPrice = Math.min(MIN_PRICE_ROW_HEIGHT, (total - minNews) / rows.length);
      const newsHeight = Math.max(
        minNews,
        Math.min(DEFAULT_NEWS_HEIGHT, total - minPrice * rows.length),
      );
      const rowHeight = Math.max(1, (total - newsHeight) / rows.length);
      this.newsWeight = newsHeight;
      this.panes = rows.map((row) => ({ row, weight: rowHeight }));
    } else {
      this.panes = rows.map((row) => ({ row, weight: oldHeight.get(row.id) ?? fallback }));
      this.newsWeight = Math.max(1, this.resolvedNewsHeight);
    }
    this.invalidateLayout();
    this.dismissHover();
    this.reqDraw();
  }

  refreshEvents(): void {
    this.reqDraw();
  }

  setTimeRange(range: Range): void {
    this.timeRange = range;
    this.notifyViewportChange();
    this.reqDraw();
  }

  getTimeRange(): Range {
    return this.timeRange;
  }

  setPriceScale(scale: number): void {
    if (!Number.isFinite(scale)) throw new Error(`Invalid price scale: ${scale}`);
    this.priceScale = scale;
    this.notifyViewportChange();
    this.reqDraw();
  }

  getPriceScale(): number {
    return this.priceScale;
  }

  setWaveletMode(mode: WaveletMode): void {
    this.waveletMode = mode;
    this.reqDraw();
  }

  getWaveletMode(): WaveletMode {
    return this.waveletMode;
  }

  setPalette(name: PaletteName): void {
    setRampPalette(name);
    this.reqDraw();
  }

  dispose(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.nowTimer !== null) clearTimeout(this.nowTimer);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.nowLine.remove();
    this.unbindEvents();
  }

  private notifyViewportChange(): void {
    this.callbacks.onViewportChange?.(
      { min: this.timeRange.min, max: this.timeRange.max },
      this.priceScale,
    );
  }

  private bindEvents(): void {
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("pointermove", this.onHoverMove);
    this.canvas.addEventListener("pointerleave", this.onHoverLeave);
    this.canvas.addEventListener("click", this.onClick);
    window.addEventListener("resize", this.onResize);
  }

  private unbindEvents(): void {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("pointermove", this.onHoverMove);
    this.canvas.removeEventListener("pointerleave", this.onHoverLeave);
    this.canvas.removeEventListener("click", this.onClick);
    window.removeEventListener("resize", this.onResize);
  }

  private resize(): void {
    const dpr = window.devicePixelRatio;
    this.plot.setDpr(dpr);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.invalidateLayout();
    this.reqDraw();
  }

  private invalidateLayout(): void {
    this.layoutRevision++;
  }

  /** Resolve layout preferences into CSS-pixel heights, caching only the derivation. */
  private resolveLayout(): void {
    const totalHeight = this.plot.cssHeight;
    if (
      this.resolvedLayoutRevision === this.layoutRevision &&
      this.resolvedLayoutHeight === totalHeight
    ) {
      return;
    }

    if (this.resolvedRowHeights.length !== this.panes.length) {
      this.resolvedRowHeights = new Float64Array(this.panes.length);
    }
    if (this.panes.length === 0) {
      this.resolvedNewsHeight = Math.max(0, totalHeight);
      this.resolvedLayoutRevision = this.layoutRevision;
      this.resolvedLayoutHeight = totalHeight;
      return;
    }

    let weightSum = Math.max(1, this.newsWeight);
    for (const pane of this.panes) weightSum += Math.max(1, pane.weight);
    const desiredRows = new Array<number>(this.panes.length);
    for (let index = 0; index < this.panes.length; index++) {
      desiredRows[index] = (Math.max(1, this.panes[index]!.weight) / weightSum) * totalHeight;
    }
    const fitted = fitStackLayout(
      (Math.max(1, this.newsWeight) / weightSum) * totalHeight,
      desiredRows,
      totalHeight,
    );
    this.resolvedNewsHeight = fitted.newsHeight;
    this.resolvedRowHeights.set(fitted.rowHeights);
    this.resolvedLayoutRevision = this.layoutRevision;
    this.resolvedLayoutHeight = totalHeight;
  }

  private onResize = (): void => this.resize();

  private draw = (): void => {
    this.resolveLayout();
    using frame = this.plot.beginFrame(this.timeRange);
    const { width, height, dpr } = frame;
    frame.fillRectPx(0, 0, width, height, "#05070d");

    const numPx = Math.ceil(width * dpr);
    if (numPx <= 0) return;
    const maxSigma = maxSigmaFor(numPx);
    const timePerPx = (this.timeRange.max - this.timeRange.min) / numPx;
    const context = kernelContext(this.waveletMode, maxSigma);
    const padLeft = context.leftCells;
    const padRight = context.rightCells;
    const edgeCount = padLeft + numPx + padRight + 1;
    if (this.evalTime.length < edgeCount) this.evalTime = new Float64Array(edgeCount);
    for (let index = 0; index < edgeCount; index++) {
      this.evalTime[index] = this.timeRange.min + (index - padLeft) * timePerPx;
    }
    const evalView = this.evalTime.subarray(0, edgeCount) as Float64Array;

    const eventResult = this.eventSource(this.timeRange);
    this.paintedEvents.events = eventResult.events;
    const eventY = this.resolvedNewsHeight / 2;
    const hovered = this.hitTest(frame.tx, eventY);
    this.publishHover(hovered, frame.tx, eventY, width, height);
    frame.text("NEWS", 8, 9, "10px ui-monospace, monospace", "#94a3b8", "left", "top");
    frame.events().drawRow(this.paintedEvents, this.feedColorOf, hovered, eventY);

    let rowY = this.resolvedNewsHeight;
    for (let index = 0; index < this.panes.length; index++) {
      const pane = this.panes[index]!;
      const rowHeight = this.resolvedRowHeights[index]!;
      const heatHeight = Math.max(2, rowHeight - RESOLUTION_BAR_HEIGHT);
      const result = pane.row.dataSource(evalView, timePerPx);
      frame.heatmap(pane.row.id).drawWaveletField(
        {
          evalTime: evalView,
          value: result.value,
          padLeft,
          padRight,
          revision: result.revision,
        },
        this.priceScale,
        this.waveletMode,
        rowY,
        heatHeight,
      );
      frame.resolution().draw(result.resolution, result.targetResolutionMs, rowY + heatHeight);
      frame.fillRectPx(
        5,
        rowY + 5,
        Math.min(width - 10, 12 + pane.row.label.length * 7),
        20,
        "rgba(5,7,13,0.78)",
      );
      frame.text(
        pane.row.label,
        11,
        rowY + 15,
        "11px ui-monospace, monospace",
        "#f8fafc",
        "left",
        "middle",
      );
      rowY += rowHeight;
      frame.fillRectPx(0, rowY - 1, width, 1, "rgba(255,255,255,0.18)");
    }

    frame.fillRectPx(0, this.resolvedNewsHeight, width, 1, "rgba(255,255,255,0.3)");
    frame.drawTimeAxis(this.resolvedNewsHeight, this.config.minTickPx);
    this.drawResizeHandles(frame);
    this.updateNowLine(timePerPx);
  };

  private drawResizeHandles(frame: Frame): void {
    if (this.panes.length === 0) return;
    let y = this.resolvedNewsHeight;
    frame.fillRectPx(frame.width / 2 - 20, y - 2, 40, 4, "rgba(203,213,225,0.62)");
    for (let index = 0; index < this.panes.length - 1; index++) {
      y += this.resolvedRowHeights[index]!;
      frame.fillRectPx(frame.width / 2 - 20, y - 2, 40, 4, "rgba(203,213,225,0.62)");
    }
  }

  private boundaryAt(y: number): number | null {
    this.resolveLayout();
    if (this.panes.length === 0) return null;
    let boundaryY = this.resolvedNewsHeight;
    if (Math.abs(y - boundaryY) <= RESIZE_HANDLE_RADIUS) return 0;
    for (let index = 0; index < this.panes.length - 1; index++) {
      boundaryY += this.resolvedRowHeights[index]!;
      if (Math.abs(y - boundaryY) <= RESIZE_HANDLE_RADIUS) return index + 1;
    }
    return null;
  }

  private moveBoundary(boundary: number, delta: number): void {
    if (this.panes.length === 0 || delta === 0) return;
    this.resolveLayout();
    const total = this.plot.cssHeight;
    const count = this.panes.length;
    const minNews = Math.min(MIN_NEWS_HEIGHT, total / (count + 1));
    const minPrice = Math.min(MIN_PRICE_ROW_HEIGHT, (total - minNews) / count);

    if (boundary === 0) {
      const pair = this.resolvedNewsHeight + this.resolvedRowHeights[0]!;
      const newsHeight = Math.max(
        minNews,
        Math.min(pair - minPrice, this.resolvedNewsHeight + delta),
      );
      this.newsWeight = newsHeight;
      this.panes[0]!.weight = pair - newsHeight;
    } else {
      const left = boundary - 1;
      const right = boundary;
      const pair = this.resolvedRowHeights[left]! + this.resolvedRowHeights[right]!;
      const leftHeight = Math.max(
        minPrice,
        Math.min(pair - minPrice, this.resolvedRowHeights[left]! + delta),
      );
      this.panes[left]!.weight = leftHeight;
      this.panes[right]!.weight = pair - leftHeight;
      this.newsWeight = this.resolvedNewsHeight;
    }

    // Preserve all unaffected panes at their currently rendered proportions.
    for (let index = 0; index < this.panes.length; index++) {
      if (boundary === 0 && index === 0) continue;
      if (boundary > 0 && (index === boundary - 1 || index === boundary)) continue;
      this.panes[index]!.weight = this.resolvedRowHeights[index]!;
    }
    this.invalidateLayout();
  }

  /** Move the wall-clock marker without invalidating data or the heatmap. */
  private updateNowLine(timePerPx: number): void {
    if (this.nowTimer !== null) clearTimeout(this.nowTimer);
    this.nowTimer = null;
    const now = Date.now();
    if (now > this.timeRange.max) {
      this.nowLine.hidden = true;
      return;
    }
    if (now >= this.timeRange.min) {
      const x =
        ((now - this.timeRange.min) / (this.timeRange.max - this.timeRange.min)) *
        this.plot.cssWidth;
      this.nowLine.hidden = false;
      this.nowLine.style.transform = `translate3d(${x - this.config.nowWidth / 2}px, 0, 0)`;
    } else {
      this.nowLine.hidden = true;
    }

    const delayMs = Math.max(1000 / 120, this.timeRange.min - now, timePerPx / 10);
    this.nowTimer = setTimeout(() => {
      this.nowTimer = null;
      this.updateNowLine(timePerPx);
    }, delayMs) as unknown as number;
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.updatePointer(event);
    if (this.pointer.kind !== "inside") return;
    const boundary = this.boundaryAt(this.pointer.y);
    if (boundary !== null) {
      this.gesture = {
        kind: "resizing",
        pointerId: event.pointerId,
        boundary,
        lastY: this.pointer.y,
      };
      if (this.dismissHover()) this.reqDraw();
      this.canvas.style.cursor = "ns-resize";
      this.canvas.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      return;
    }
    this.gesture = {
      kind: "panning",
      pointerId: event.pointerId,
      lastClientX: event.clientX,
    };
    this.canvas.setPointerCapture?.(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (gesture.kind === "resizing") {
      if (event.pointerId !== gesture.pointerId) return;
      const y = this.clientToCanvasY(event.clientY);
      this.moveBoundary(gesture.boundary, y - gesture.lastY);
      gesture.lastY = y;
      this.reqDraw();
      return;
    }
    if (gesture.kind !== "panning" || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.lastClientX;
    gesture.lastClientX = event.clientX;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    const span = this.timeRange.max - this.timeRange.min;
    this.setTimeRange(Range.pan(this.timeRange, -(dx / rect.width) * span));
  };

  private onPointerUp = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (gesture.kind !== "idle" && event.pointerId !== gesture.pointerId) return;
    this.gesture = IDLE_GESTURE;
    this.canvas.releasePointerCapture?.(event.pointerId);
    this.updatePointer(event);
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
    const span = this.timeRange.max - this.timeRange.min;
    const dt = (this.config.timeScrollSensitivity * span * event.deltaX) / cssWidth;
    if (dt !== 0) this.setTimeRange(Range.pan(this.timeRange, dt));
    if (event.shiftKey) {
      this.setPriceScale(this.priceScale - dy * this.config.wheelSensitivity);
      return;
    }
    const tx = new DataTransform(
      this.timeRange,
      Range.create(0, cssWidth),
      Range.create(0, cssHeight),
    );
    const factor = Math.exp(-dy * this.config.wheelSensitivity);
    this.setTimeRange(Range.zoom(this.timeRange, tx.xToTime(px), factor));
  };

  private onHoverMove = (event: PointerEvent): void => {
    this.updatePointer(event);
    if (this.pointer.kind !== "inside") return;
    this.canvas.style.cursor = this.boundaryAt(this.pointer.y) === null ? "" : "ns-resize";
    if (this.gesture.kind !== "idle") return;
    if (this.currentHoverEvent() !== this.paintedHover) this.reqDraw();
  };

  private onHoverLeave = (): void => {
    this.pointer = OUTSIDE_POINTER;
    if (this.gesture.kind !== "idle") return;
    if (this.dismissHover()) this.reqDraw();
  };

  private onClick = (event: PointerEvent): void => {
    this.updatePointer(event);
    const hovered = this.currentHoverEvent();
    if (hovered !== null) window.open(hovered.link, "_blank", "noopener,noreferrer");
  };

  private updatePointer(event: Pick<PointerEvent, "clientX" | "clientY">): void {
    const rect = this.canvas.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    ) {
      this.pointer = OUTSIDE_POINTER;
      return;
    }
    const x = (event.clientX - rect.left) * (this.plot.cssWidth / rect.width);
    const y = (event.clientY - rect.top) * (this.plot.cssHeight / rect.height);
    if (this.pointer.kind === "inside") {
      this.pointer.x = x;
      this.pointer.y = y;
    } else {
      this.pointer = { kind: "inside", x, y };
    }
  }

  private clientToCanvasY(clientY: number): number {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.height <= 0) return 0;
    return (clientY - rect.top) * (this.plot.cssHeight / rect.height);
  }

  private currentHoverEvent(): NewsEvent | null {
    const width = this.plot.cssWidth;
    const height = this.plot.cssHeight;
    if (!(width > 0) || !(height > 0)) return null;
    this.resolveLayout();
    const tx = new DataTransform(this.timeRange, Range.create(0, width), Range.create(0, height));
    const index = this.hitTest(tx, this.resolvedNewsHeight / 2);
    return index === null ? null : this.eventAt(index);
  }

  private hitTest(tx: DataTransform, eventY: number): number | null {
    if (this.pointer.kind !== "inside" || this.gesture.kind !== "idle") return null;
    if (this.boundaryAt(this.pointer.y) !== null) return null;
    return hitTestEvent(this.paintedEvents, tx, this.pointer.x, this.pointer.y, eventY);
  }

  private eventAt(index: number): NewsEvent {
    const event = this.paintedEvents.events[index];
    if (event === undefined) throw new Error(`Event index out of range: ${index}`);
    return event;
  }

  private publishHover(
    index: number | null,
    tx: DataTransform,
    eventY: number,
    width: number,
    height: number,
  ): void {
    if (index === null) {
      this.paintedHover = null;
      this.callbacks.onHover?.(null);
      return;
    }
    const event = this.eventAt(index);
    this.paintedHover = event;
    if (this.callbacks.onHover === undefined) return;
    const info = this.hoverInfo;
    info.index = index;
    info.title = event.title;
    info.link = event.link;
    info.feedId = event.feedId;
    info.summary = event.summary;
    info.t = event.t;
    info.anchorX = tx.timeToX(event.t);
    info.anchorY = eventY;
    info.viewportWidth = width;
    info.viewportHeight = height;
    this.callbacks.onHover(info);
  }

  private dismissHover(): boolean {
    const changed = this.paintedHover !== null;
    this.paintedHover = null;
    this.callbacks.onHover?.(null);
    return changed;
  }
}
