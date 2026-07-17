import { Interval } from "../core/interval.ts";
import type { EventSet, NewsEvent } from "../domain.ts";
import type { CanvasPoint, CanvasSize } from "./coordinates.ts";
import { transformTouchInterval, type GestureInputKind } from "./gesture.ts";
import {
  signalRowContainsHeatmap,
  MIN_NEWS_HEIGHT,
  RESIZE_HANDLE_RADIUS,
  ROW_REMOVE_THRESHOLD,
} from "./gfx/layout.ts";
import { eventIndexAtOrBefore, eventIndexNearPoint } from "./hittest.ts";
import type { Plot } from "./plot.ts";
import {
  TimelineGestureController,
  type GestureTarget,
  type TimelineGestureHost,
} from "./timelineGestureController.ts";
import type { DataTransform } from "./transform.ts";

const DEFAULT_NOW_ANCHOR = 0.85;
const RIGHT_EDGE_NOW_ANCHOR = 1;
export interface HoverInfo {
  readonly index: number;
  readonly title: string;
  readonly link: string;
  readonly feedId: string;
  readonly summary: string;
  readonly t: number;
}

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

export interface TimelineInteractionState {
  events: EventSet;
  timeInterval: Interval;
  logGain: number;
  hovered: number | null;
  newsHeight: number;
  playback: TimelinePlayback;
}

export interface TimelineInteractionRow {
  readonly row: { readonly id: string };
  height: number;
  verticalOffset: number;
}

export interface TimelineInteractionCallbacks {
  readonly onHover?: (event: HoverInfo | null) => void;
  readonly onViewportChange?: (viewport: Interval, priceScale: number) => void;
  readonly onPlaybackChange?: (playback: TimelinePlayback) => void;
  readonly onLayoutChange?: (layout: TimelineLayout, collapsedRowIds: readonly string[]) => void;
}

export interface TimelineInteractionOverlay {
  setEventTooltipAnchor(
    visible: boolean,
    x: number,
    y: number,
    viewportWidth: number,
    viewportHeight: number,
  ): void;
}

export interface TimelineInteractionOptions {
  readonly canvas: HTMLCanvasElement;
  readonly viewport: CanvasSize;
  readonly signal: AbortSignal;
  readonly plot: Plot;
  readonly state: TimelineInteractionState;
  readonly rows: () => readonly TimelineInteractionRow[];
  readonly overlay?: TimelineInteractionOverlay;
  readonly callbacks: TimelineInteractionCallbacks;
  readonly requestDraw: () => void;
  readonly wheelLineHeight: number;
  readonly wheelSensitivity: number;
  readonly timeScrollSensitivity: number;
}

/** Domain interaction owner between native gesture decoding and timeline rendering. */
export class TimelineInteractionModel implements TimelineGestureHost {
  private readonly controller: TimelineGestureController;
  private readonly canvas: HTMLCanvasElement;
  private readonly plot: Plot;
  private readonly state: TimelineInteractionState;
  private readonly rows: () => readonly TimelineInteractionRow[];
  private readonly overlay: TimelineInteractionOverlay | undefined;
  private readonly callbacks: TimelineInteractionCallbacks;
  private readonly requestDraw: () => void;
  private readonly wheelSensitivity: number;
  private readonly timeScrollSensitivity: number;
  private layoutChangePending = false;
  private crosshairPinned = false;
  private eventTooltipHovered = false;
  private hoverClearTimer: number | null = null;
  private notifiedHover: HoverInfo | null = null;

  constructor(options: TimelineInteractionOptions) {
    this.canvas = options.canvas;
    this.plot = options.plot;
    this.state = options.state;
    this.rows = options.rows;
    this.overlay = options.overlay;
    this.callbacks = options.callbacks;
    this.requestDraw = options.requestDraw;
    this.wheelSensitivity = options.wheelSensitivity;
    this.timeScrollSensitivity = options.timeScrollSensitivity;
    this.controller = new TimelineGestureController({
      canvas: options.canvas,
      viewport: options.viewport,
      wheelLineHeight: options.wheelLineHeight,
      host: this,
      signal: options.signal,
    });
  }

  get pointer(): CanvasPoint {
    return this.controller.pointer;
  }

  get pointerInside(): boolean {
    return this.controller.pointerInside;
  }

  get active(): boolean {
    return this.controller.active;
  }

  get activeBoundary(): number | null {
    return this.controller.activeBoundary;
  }

  setEventTooltipHovered(hovered: boolean): void {
    this.eventTooltipHovered = hovered;
    if (hovered) {
      this.cancelScheduledHoverClear();
      this.requestDraw();
    } else if (this.state.hovered === null) {
      this.cancelScheduledHoverClear();
    } else {
      this.scheduleHoverClear();
    }
  }

  setTimeInterval(range: Interval): void {
    this.applyTimeInterval(range, true);
  }

  setPriceScale(scale: number): void {
    this.state.logGain = scale;
    this.notifyViewportChange();
    this.requestDraw();
  }

  togglePlayback(): void {
    const playback =
      this.state.playback.mode === "following"
        ? ({ mode: "paused" } as const)
        : ({ mode: "following", anchor: this.captureNowAnchor(Date.now()) } as const);
    this.setPlayback(playback);
  }

  canShowHoverOverlay(): boolean {
    return (
      (this.pointerInside || this.eventTooltipHovered || this.crosshairPinned) &&
      !this.active &&
      this.boundaryAt(this.pointer.y) === null
    );
  }

  updateHover(tx: DataTransform, eventY: number, width: number, height: number): boolean {
    const previous = this.state.hovered;
    const index = this.canShowHoverOverlay()
      ? eventIndexAtOrBefore(this.state.events, tx, this.pointer.x)
      : null;
    this.state.hovered = index;
    if (index === null) {
      this.clearHover();
      return previous !== null;
    }

    const event = this.eventAt(index);
    const anchorX = Math.max(0, Math.min(width, tx.timeToX(event.t)));
    this.overlay?.setEventTooltipAnchor(true, anchorX, eventY, width, height);
    if (sameHover(this.notifiedHover, index, event) || this.callbacks.onHover === undefined) {
      return previous !== index;
    }

    const info: HoverInfo = {
      index,
      title: event.title,
      link: event.link,
      feedId: event.feedId,
      summary: event.summary,
      t: event.t,
    };
    this.notifiedHover = info;
    this.callbacks.onHover(info);
    return previous !== index;
  }

  clearHover(): boolean {
    const visualChanged = this.state.hovered !== null;
    this.state.hovered = null;
    this.overlay?.setEventTooltipAnchor(false, 0, 0, 0, 0);
    if (this.notifiedHover !== null) {
      this.notifiedHover = null;
      this.callbacks.onHover?.(null);
    }
    return visualChanged;
  }

  getLayout(): TimelineLayout {
    return {
      newsHeight: this.state.newsHeight,
      rows: this.rows().map(runtime => ({
        id: runtime.row.id,
        height: runtime.height,
        verticalOffset: runtime.verticalOffset,
      })),
    };
  }

  close(): void {
    if (this.hoverClearTimer !== null) clearTimeout(this.hoverClearTimer);
    this.hoverClearTimer = null;
  }

  targetAt(point: CanvasPoint): GestureTarget {
    const boundary = this.boundaryAt(point.y);
    return boundary === null
      ? { kind: "viewport", row: this.rowAt(point.y) }
      : { kind: "boundary", index: boundary };
  }

  gestureStarted(): void {
    this.crosshairPinned = false;
    this.clearHover();
    this.requestDraw();
  }

  gestureEnded(
    input: GestureInputKind,
    cancelled: boolean,
    finished: boolean,
    pointerInside: boolean,
  ): void {
    this.flushLayoutChange(finished);
    if (input === "touch" && finished) this.crosshairPinned = !cancelled && pointerInside;
    if (cancelled) this.clearHover();
    else if (input === "touch" && finished) this.updateHoverAtCurrentTransform();
    if (finished && !pointerInside) this.scheduleHoverClear();
    this.requestDraw();
  }

  panTimeByPixels(deltaX: number, viewportWidth: number): void {
    if (deltaX === 0 || !(viewportWidth > 0)) return;
    const span = Interval.span(this.state.timeInterval);
    this.panTimeInterval(Interval.pan(this.state.timeInterval, -(deltaX / viewportWidth) * span));
  }

  panRow(index: number | null, deltaY: number): void {
    if (index === null || deltaY === 0) return;
    const runtime = this.rows()[index];
    if (runtime === undefined) return;
    const next = runtime.verticalOffset + deltaY;
    if (next === runtime.verticalOffset) return;
    runtime.verticalOffset = next;
    this.layoutChangePending = true;
    this.requestDraw();
  }

  resizeBoundary(index: number, deltaY: number): void {
    this.moveBoundary(index, deltaY);
    this.requestDraw();
  }

  pinchTime(
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
    if (Math.abs(currentCenterX - previousCenterX) >= 0.5) this.panTimeInterval(transformed);
    else this.setTimeInterval(transformed);
  }

  wheel(point: CanvasPoint, deltaX: number, deltaY: number, shiftKey: boolean): void {
    const cssWidth = this.plot.cssWidth;
    if (!(cssWidth > 0)) return;
    const span = Interval.span(this.state.timeInterval);
    const dt = (this.timeScrollSensitivity * span * deltaX) / cssWidth;
    if (dt !== 0) this.panTimeInterval(Interval.pan(this.state.timeInterval, dt));
    if (shiftKey) {
      this.setPriceScale(this.state.logGain - deltaY * this.wheelSensitivity);
    } else if (deltaY !== 0) {
      const anchorTime = this.state.timeInterval.start + (point.x / cssWidth) * span;
      this.panTimeInterval(
        Interval.zoom(
          this.state.timeInterval,
          anchorTime,
          Math.exp(-deltaY * this.wheelSensitivity),
        ),
      );
    }
  }

  hoverMoved(point: CanvasPoint, pointerInside: boolean): void {
    if (pointerInside) this.cancelScheduledHoverClear();
    const boundary = this.boundaryAt(point.y);
    this.canvas.style.cursor =
      boundary !== null
        ? "ns-resize"
        : this.clickableEventIndexAtCurrentTransform(point) !== null
          ? "pointer"
          : "";
    this.updateHoverAtCurrentTransform();
    this.requestDraw();
  }

  pointerLeft(): void {
    this.scheduleHoverClear();
  }

  tap(point: CanvasPoint): void {
    const clickedEventIndex = this.clickableEventIndexAtCurrentTransform(point);
    this.updateHoverAtCurrentTransform();
    this.requestDraw();
    if (clickedEventIndex === null) return;
    window.open(this.eventAt(clickedEventIndex).link, "_blank", "noopener,noreferrer");
  }

  doubleTap(point: CanvasPoint): void {
    if (this.clickableEventIndexAtCurrentTransform(point) !== null) return;
    this.crosshairPinned = false;
    this.followNowAtRightEdge();
  }

  private applyTimeInterval(range: Interval, notify: boolean): void {
    this.state.timeInterval = range;
    this.plot.setTimeInterval(range);
    if (notify) this.notifyViewportChange();
    this.requestDraw();
  }

  private setPlayback(playback: TimelinePlayback): void {
    if (samePlayback(playback, this.state.playback)) return;
    this.state.playback = playback;
    this.callbacks.onPlaybackChange?.(playback);
    this.requestDraw();
  }

  private captureNowAnchor(now: number): number {
    const span = Interval.span(this.state.timeInterval);
    return span > 0 ? (now - this.state.timeInterval.start) / span : DEFAULT_NOW_ANCHOR;
  }

  private panTimeInterval(range: Interval): void {
    this.state.timeInterval = range;
    this.plot.setTimeInterval(range);
    this.setPlayback({ mode: "paused" });
    this.notifyViewportChange();
    this.requestDraw();
  }

  private followNowAtRightEdge(): void {
    const now = Date.now();
    const span = Interval.span(this.state.timeInterval);
    if (!(span > 0)) return;
    this.state.playback = { mode: "following", anchor: RIGHT_EDGE_NOW_ANCHOR };
    this.applyTimeInterval(Interval.create(now - span, now), true);
    this.callbacks.onPlaybackChange?.(this.state.playback);
  }

  private notifyViewportChange(): void {
    this.callbacks.onViewportChange?.(this.state.timeInterval, this.state.logGain);
  }

  private flushLayoutChange(removeCollapsedRows: boolean): void {
    if (!this.layoutChangePending) return;
    this.layoutChangePending = false;
    const collapsedRowIds = removeCollapsedRows
      ? this.rows()
          .filter(runtime => runtime.height <= ROW_REMOVE_THRESHOLD)
          .map(runtime => runtime.row.id)
      : [];
    this.callbacks.onLayoutChange?.(this.getLayout(), collapsedRowIds);
  }

  private boundaryAt(y: number): number | null {
    const rows = this.rows();
    if (rows.length === 0) return null;
    let boundaryY = this.state.newsHeight;
    if (Math.abs(y - boundaryY) <= RESIZE_HANDLE_RADIUS) return 0;
    for (let index = 0; index < rows.length - 1; index++) {
      boundaryY += rows[index]!.height;
      if (Math.abs(y - boundaryY) <= RESIZE_HANDLE_RADIUS) return index + 1;
    }
    return null;
  }

  private rowAt(y: number): number | null {
    let rowY = this.state.newsHeight;
    const rows = this.rows();
    for (let index = 0; index < rows.length; index++) {
      if (signalRowContainsHeatmap(rowY, rows[index]!.height, y)) return index;
      rowY += rows[index]!.height;
    }
    return null;
  }

  private moveBoundary(boundary: number, delta: number): void {
    const rows = this.rows();
    if (rows.length === 0 || delta === 0) return;
    this.layoutChangePending = true;
    if (boundary === 0) {
      const pair = this.state.newsHeight + rows[0]!.height;
      const newsHeight = Math.max(
        Math.min(MIN_NEWS_HEIGHT, pair),
        Math.min(pair, this.state.newsHeight + delta),
      );
      rows[0]!.height = pair - newsHeight;
      this.state.newsHeight = newsHeight;
      return;
    }
    const left = boundary - 1;
    const right = boundary;
    const pair = rows[left]!.height + rows[right]!.height;
    rows[left]!.height = Math.max(0, Math.min(pair, rows[left]!.height + delta));
    rows[right]!.height = pair - rows[left]!.height;
  }

  private updateHoverAtCurrentTransform(): boolean {
    const width = this.plot.cssWidth;
    const height = this.plot.cssHeight;
    if (!(width > 0) || !(height > 0)) return this.clearHover();
    return this.updateHover(
      this.plot.createTransform(width, height),
      this.state.newsHeight / 2,
      width,
      height,
    );
  }

  private clickableEventIndexAtCurrentTransform(point: CanvasPoint): number | null {
    const width = this.plot.cssWidth;
    const height = this.plot.cssHeight;
    if (!(width > 0) || !(height > 0) || !this.pointerInside) return null;
    return eventIndexNearPoint(
      this.state.events,
      this.plot.createTransform(width, height),
      point,
      this.state.newsHeight / 2,
    );
  }

  private eventAt(index: number): NewsEvent {
    const event = this.state.events.events[index];
    if (event === undefined) throw new Error(`Event index out of range: ${index}`);
    return event;
  }

  private scheduleHoverClear(): void {
    if (
      this.pointerInside ||
      this.eventTooltipHovered ||
      this.crosshairPinned ||
      this.active ||
      this.hoverClearTimer !== null
    ) {
      return;
    }
    this.hoverClearTimer = window.setTimeout(() => {
      this.hoverClearTimer = null;
      if (this.pointerInside || this.eventTooltipHovered || this.crosshairPinned || this.active) {
        return;
      }
      this.clearHover();
      this.requestDraw();
    }, 0);
  }

  private cancelScheduledHoverClear(): void {
    if (this.hoverClearTimer === null) return;
    clearTimeout(this.hoverClearTimer);
    this.hoverClearTimer = null;
  }
}

function sameHover(info: HoverInfo | null, index: number, event: NewsEvent): boolean {
  return (
    info !== null &&
    info.index === index &&
    info.t === event.t &&
    info.title === event.title &&
    info.link === event.link &&
    info.feedId === event.feedId &&
    info.summary === event.summary
  );
}

export function normalizePlayback(playback: TimelinePlayback): TimelinePlayback {
  if (playback.mode !== "following") return playback;
  const anchor = Number.isFinite(playback.anchor) ? playback.anchor : DEFAULT_NOW_ANCHOR;
  return { mode: "following", anchor: Math.max(0, Math.min(1, anchor)) };
}

function samePlayback(a: TimelinePlayback, b: TimelinePlayback): boolean {
  return (
    a.mode === b.mode && (a.mode === "paused" || (b.mode === "following" && a.anchor === b.anchor))
  );
}
