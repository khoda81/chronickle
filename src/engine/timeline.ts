/**
 * Timeline controller.
 *
 * Owns the canvas, the render loop (requestAnimationFrame), and the input
 * handlers (pan via drag, zoom via wheel, hover/click on event nodes).
 *
 * State model (minimal mutation):
 *  - `timeRange`: the only mutable view state, replaced wholesale on pan/zoom.
 *  - `hovered`: event index under cursor, or null.
 *  - `series` / `events`: immutable data references, swapped by the app.
 *
 * The render loop runs continuously but only redraws when `dirty` is set,
 * avoiding wasted work when idle. Panning sets dirty every frame. Drawing is
 * driven through the `Plot`'s disposable `Frame` (immediate mode).
 *
 * DPR: the canvas backing store is resized to `cssSize * dpr` on resize, but
 * the DPR-scaled ctx transform is applied per-frame by `Frame` (not here), so
 * it can never be lost across nested save/restore.
 *
 * Wheel: `deltaY` is normalized to pixels across `deltaMode`s (pixels, lines,
 * pages) before being mapped to a zoom factor. Lines use the CSS line height.
 */

import type { EventSet, NewsEvent } from "../domain.ts";
import { Range } from "./range.ts";
import { DataTransform } from "./transform.ts";
import { Plot } from "./plot.ts";
import { hitTestEvent } from "./hittest.ts";
import { setRampPalette, type PaletteName } from "./ramp.ts";
import { maxSigmaFor } from "./gfx/layout.ts";
import { DEFAULT_MIN_TICK_PX } from "./gfx/axis.ts";
import type { Frame } from "./gfx/context.ts";
import type { QueryResult } from "../data/brokerOrchestrator.ts";

/**
 * Synchronous data source the timeline queries every frame.
 *
 * The timeline computes W+1 pixel-boundary timestamps from its current
 * transform and calls `dataSource(evalTime, maxDeltaTMs)`. The source (a
 * `Broker` closure) returns staircase values at those timestamps from its
 * cache, and may trigger an async fetch if coverage is incomplete — which
 * fires the broker's subscribers, which call `timeline.reqDraw()`.
 *
 * The timeline never stores the series; it pulls fresh every frame. There
 * is no draw without querying the source.
 */
export type DataSource = (evalTime: Float64Array, maxDeltaTMs: number) => QueryResult;

export interface HoverInfo {
  readonly index: number;
  readonly title: string;
  readonly link: string;
  readonly source: string;
  readonly t: number;
  /** Cursor x in canvas-relative CSS pixels. */
  readonly px: number;
  /** Cursor y in canvas-relative CSS pixels. */
  readonly py: number;
}

export interface TimelineCallbacks {
  /** Called when the user hovers an event (or leaves it). */
  onHover?: (event: HoverInfo | null) => void;
}

export interface TimelineOptions {
  readonly canvas: HTMLCanvasElement;
  readonly initialTimeRange: Range;
  readonly callbacks?: TimelineCallbacks;
  /**
   /** Synchronous data source queried every frame. Required — the timeline
    * no longer stores a series; it pulls from this callback each draw.
    */
  readonly dataSource: DataSource;
  /** Minimum on-screen spacing between axis ticks (CSS px). */
  readonly minTickPx?: number;
}

interface TimelineState {
  events: EventSet;
  timeRange: Range;
  // TODO: Maybe this should be in the transform state instead?
  priceScale: number;
  hovered: number | null;
  // TODO: Instead of a dirty flag, just request a draw using requestAnimationFrame
  dirty: boolean;
}

const EMPTY_EVENTS: EventSet = { events: [] };

// TODO: These should live in a config object instead of a global constant
/** CSS line height used to normalize wheel `deltaMode: 1` (lines). */
const WHEEL_LINE_HEIGHT = 16;
/** Zoom sensitivity per normalized pixel of wheel delta. */
const WHEEL_SENSITIVITY = 0.003;
/** Time scroll sensitivity per normalized pixel of wheel delta. */
const TIMESCROLL_SENSITIVITY = 3;

/** "Now" marker line width (CSS px). */
const NOW_WIDTH = 1;
// TODO: These should live in a theme or color config object instead of a global constant
/** "Now" marker stroke color. */
const NOW_STROKE = "rgba(255, 255, 255, 0.55)";

export class Timeline {
  private readonly canvas: HTMLCanvasElement;
  private readonly plot: Plot;
  private readonly callbacks: TimelineCallbacks;
  private readonly dataSource: DataSource;
  private readonly minTickPx: number;
  private state: TimelineState;
  private rafId: number | null = null;

  // Pan scratch (no allocation in handlers).
  private dragging = false;
  private lastX = 0;

  // Reusable eval-time buffer, grown as needed. Avoids per-frame allocation
  // in the render loop (AGENTS.md §5). Covers the visible width plus padding
  // on both sides so off-screen jumps near the edges still contribute to the
  // wavelet response on screen.
  private evalTime: Float64Array = new Float64Array(0);

  // "Now" marker timer. Armed by `drawNow` to fire when wall-clock time
  // crosses the next device-pixel boundary, so the line moves one pixel at a
  // time without a 60fps timer. Cleared on dispose and re-armed every frame.
  private nowTimer: number | null = null;

  constructor(opts: TimelineOptions) {
    this.canvas = opts.canvas;
    this.dataSource = opts.dataSource;
    this.minTickPx = opts.minTickPx ?? DEFAULT_MIN_TICK_PX;
    this.plot = new Plot({
      canvas: opts.canvas,
      initialTimeRange: opts.initialTimeRange,
    });
    this.callbacks = opts.callbacks ?? {};
    this.state = {
      events: EMPTY_EVENTS,
      timeRange: opts.initialTimeRange,
      priceScale: 22,
      hovered: null,
      dirty: true,
    };

    this.bindEvents();
    this.resize();
    this.loop();
  }

  /** Request a redraw on the next frame (e.g. when the broker has new data). */
  reqDraw(): void {
    this.state = { ...this.state, dirty: true };
  }

  /** Replace the event set. Triggers a redraw. */
  setEvents(events: EventSet): void {
    this.state = { ...this.state, events, hovered: null, dirty: true };
  }

  /** Replace the visible time range (e.g. fit-to-data). Triggers a redraw. */
  setTimeRange(r: Range): void {
    this.state = { ...this.state, timeRange: r, dirty: true };
    this.plot.setTimeRange(r);
  }

  /** Current visible time range. */
  getTimeRange(): Range {
    return this.state.timeRange;
  }

  /** Switch the heatmap color palette by name. Triggers a redraw. */
  setPalette(name: PaletteName): void {
    setRampPalette(name);
    this.state = { ...this.state, dirty: true };
  }

  /** Stop the render loop and detach listeners. */
  dispose(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.nowTimer !== null) clearTimeout(this.nowTimer);
    this.unbindEvents();
  }

  // --- internals ---

  private bindEvents(): void {
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("pointermove", this.onHoverMove);
    this.canvas.addEventListener("click", this.onClick);
    window.addEventListener("resize", this.onResize);
  }

  private unbindEvents(): void {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("pointermove", this.onHoverMove);
    this.canvas.removeEventListener("click", this.onClick);
    window.removeEventListener("resize", this.onResize);
  }

  private resize(): void {
    const dpr = window.devicePixelRatio;
    this.plot.setDpr(dpr);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    // Note: no setTransform here — the Frame applies the DPR transform per
    // draw, so it can never be lost across save/restore.
    // TODO: Get rid of the dirty flag and rely on requestAnimationFrame instead
    this.state = { ...this.state, dirty: true };
  }

  private onResize = (): void => this.resize();

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (!this.state.dirty) return;
    this.state = { ...this.state, dirty: false };

    using frame = this.plot.beginFrame();
    const { events, hovered, priceScale, timeRange } = this.state;
    const width = frame.width;

    // Background.
    frame.fillRectPx(0, 0, frame.width, frame.height, "#05070d");

    const dpr = window.devicePixelRatio || 1;
    const numPx = Math.ceil(width * dpr);
    const maxSigma = maxSigmaFor(numPx);
    // timePerPx in *device* pixels (maxSigma is in device pixels).
    const timePerPx = (timeRange.max - timeRange.min) / numPx;
    const kernelReach = maxSigma * timePerPx; // in epoch ms

    // Pad by exactly kernelReach on each side: one maxSigma-width of samples
    // at the per-device-pixel spacing. The padded grid is uniform so the box
    // filter (whose sigma is in device pixels) operates correctly.
    const padLeft = maxSigma;
    const padRight = maxSigma;
    const paddedN = padLeft + numPx + padRight;
    const paddedMin = timeRange.min - padLeft * timePerPx;
    const paddedMax = timeRange.max + padRight * timePerPx;
    const paddedSpan = paddedMax - paddedMin;

    if (this.evalTime.length < paddedN) {
      this.evalTime = new Float64Array(paddedN);
    }
    const step = paddedSpan / (paddedN - 1);
    for (let i = 0; i < paddedN; i++) {
      this.evalTime[i] = paddedMin + i * step;
    }
    const evalView = this.evalTime.subarray(0, paddedN) as Float64Array;
    // maxDeltaTMs for the fetch: one sample per visible device pixel is the
    // floor. The off-screen padding could be coarser (the kernel there is
    // wide and smooth), but the broker dedups by range and the staircase
    // evaluator handles any spacing, so using the visible step everywhere is
    // correct and simple. A future optimization could query the off-screen
    // region at a coarser maxDeltaTMs to reduce fetch/eval cost.
    const result = this.dataSource(evalView, timePerPx);

    // Layers.
    const heat = frame.heatmap();
    heat.drawWaveletField(
      { evalTime: evalView, value: result.value, padLeft, padRight },
      priceScale,
    );
    // heat.drawFadeOverlay();
    frame.events().drawRow(events, hovered);
    frame.drawTimeAxis(this.minTickPx);

    // "Now" marker: a vertical line at the current wall-clock time. It only
    // moves when `now` crosses a pixel boundary, so we schedule the next
    // redraw for exactly that moment instead of running a 60fps timer. The
    // delay is `timePerPx` ms (one device pixel of time); when zoomed out
    // far enough that a pixel spans minutes or hours, the timer fires only
    // every few minutes/hours. When `now` is off-screen, no timer is needed
    // — panning/zooming back into view re-arms it via the redraw path.
    this.drawNow(frame, timeRange, timePerPx);
  };

  /**
   * Draw the "now" vertical line and arm a timer for the next pixel crossing.
   *
   * The line is drawn at `Date.now()` if it falls within the visible time
   * range. We then schedule a `reqDraw` for the moment `now` advances by one
   * device pixel (`timePerPx` ms), so the line appears to move continuously
   * without burning a per-frame timer. The timer is cleared and re-armed on
   * every draw, so panning/zooming (which changes `timePerPx` or moves `now`
   * on/off screen) is handled naturally by the next frame.
   */
  private drawNow(frame: Frame, timeRange: Range, timePerPx: number): void {
    if (this.nowTimer !== null) {
      clearTimeout(this.nowTimer);
      this.nowTimer = null;
    }

    const now = Date.now();
    if (now > timeRange.max) return;

    const x = frame.tx.timeToX(now);
    frame.vline(x, 0, frame.height, NOW_STROKE, NOW_WIDTH);

    // Delay until `now` crosses the next device-pixel boundary. We compute
    // the fractional pixel position and arm a timer for the remainder of the
    // current pixel plus (n-1) full pixels — but since we only need to move by
    // one pixel to be visually correct, the delay is simply `timePerPx` minus
    // the sub-pixel remainder of the current position. Using the remainder
    // keeps the line phase-locked to wall-clock time across re-arms.
    const fracPx = x - Math.floor(x);
    // TODO: Should this change based on dpr too?
    const tillNextChange = (timePerPx * (1 - fracPx)) / 4;
    const timeToMin = timeRange.min - now;
    const delayMs = Math.max(timeToMin, tillNextChange);
    this.nowTimer = setTimeout(() => {
      this.nowTimer = null;
      this.reqDraw();
    }, delayMs) as unknown as number;
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.dragging = true;
    this.lastX = e.clientX;
    this.canvas.setPointerCapture?.(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    this.lastX = e.clientX;
    const width = this.plot.cssWidth;
    if (width <= 0) return;
    const span = this.state.timeRange.max - this.state.timeRange.min;
    const dtMs = (dx / width) * span;
    this.setTimeRange(Range.pan(this.state.timeRange, -dtMs));
  };

  private onPointerUp = (e: PointerEvent): void => {
    this.dragging = false;
    this.canvas.releasePointerCapture?.(e.pointerId);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const width = this.plot.cssWidth;
    if (width <= 0) return;

    // Normalize deltaY to pixels across deltaModes.
    let dy = e.deltaY;
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) dy *= WHEEL_LINE_HEIGHT;
    else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) dy *= this.plot.cssHeight;
    else if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) dy *= 1;

    // Apply horizontal scrolling
    if (width > 0) {
      const span = this.state.timeRange.max - this.state.timeRange.min;
      const dt = (TIMESCROLL_SENSITIVITY * (span * e.deltaX)) / width;
      this.setTimeRange(Range.pan(this.state.timeRange, dt));
      this.state.dirty = true;
    }

    if (e.shiftKey) {
      this.state.priceScale -= dy * WHEEL_SENSITIVITY;
      this.state.dirty = true;
      return;
    }
    const tx = new DataTransform(
      this.state.timeRange,
      Range.create(0, width),
      Range.create(0, this.plot.cssHeight),
    );
    const tFocus = tx.xToTime(px);
    const factor = Math.exp(-dy * WHEEL_SENSITIVITY);
    this.setTimeRange(Range.zoom(this.state.timeRange, tFocus, factor));
  };

  private onHoverMove = (e: PointerEvent): void => {
    if (this.dragging) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const width = this.plot.cssWidth;
    const height = this.plot.cssHeight;
    if (width <= 0 || height <= 0) return;

    const tx = new DataTransform(
      this.state.timeRange,
      Range.create(0, width),
      Range.create(0, height),
    );
    const idx = hitTestEvent(this.state.events, tx, px, py);
    if (idx !== this.state.hovered) {
      this.state = { ...this.state, hovered: idx, dirty: true };
      this.fireHover(idx, px, py);
    }
  };

  private onClick = (_e: PointerEvent): void => {
    if (this.state.hovered === null) return;
    const ev = this.eventAt(this.state.hovered);
    window.open(ev.link, "_blank", "noopener,noreferrer");
  };

  private eventAt(i: number): NewsEvent {
    const e = this.state.events.events[i];
    if (e === undefined) {
      throw new Error(`Event index out of range: ${i}`);
    }
    return e;
  }

  private fireHover(idx: number | null, px: number, py: number): void {
    if (!this.callbacks.onHover) return;
    if (idx === null) {
      this.callbacks.onHover(null);
      return;
    }
    const ev = this.eventAt(idx);
    this.callbacks.onHover({
      index: idx,
      title: ev.title,
      link: ev.link,
      source: ev.source,
      t: ev.t,
      px,
      py,
    });
  }
}
