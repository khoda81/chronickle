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
import type { EventQueryResult } from "../data/eventBroker.ts";

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

/**
 * Synchronous event source the timeline queries on viewport changes.
 *
 * Returns the cached events in `range` (a snapshot, sorted ascending by t)
 * and a status hint. The source (an `EventBroker` closure) may trigger an
 * async backfill for unfilled sub-ranges; its subscribers should call
 * `timeline.refreshEvents()` when new data lands so the visible slice is
 * re-pulled.
 */
export type EventSource = (range: Range) => EventQueryResult;

export interface HoverInfo {
  readonly index: number;
  readonly title: string;
  readonly link: string;
  /** Stable feed id; the caller resolves it to a display name + color. */
  readonly feedId: string;
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
  /**
   * Synchronous event source queried on viewport changes. Returns the
   * cached events in the visible range and may trigger async backfill.
   * Required — the timeline no longer stores events directly; it pulls
   * them from this callback whenever the viewport moves.
   */
  readonly eventSource: EventSource;
  /**
   * Resolves a feed id to its color string (oklch or otherwise) for the
   * event renderer. Required — the renderer is pure and does not own the
   * FeedRegistry, so the caller injects the lookup.
   */
  readonly feedColorOf: (feedId: string) => string;
  /** Tunable parameters. Defaults to `DEFAULT_TIMELINE_CONFIG`. */
  readonly config?: Partial<TimelineConfig>;
}

/**
 * Render-only parameters that are not view state: they don't change with
 * pan/zoom/hover, so they live on the Timeline rather than TimelineState.
 * `priceScale` is the one exception — it's user-adjustable (shift+wheel) and
 * read in the draw path, so it stays on TimelineState as a render parameter.
 */
interface TimelineState {
  events: EventSet;
  timeRange: Range;
  /** Heatmap vertical scale; adjusted via shift+wheel. Render parameter. */
  priceScale: number;
  hovered: number | null;
}

const EMPTY_EVENTS: EventSet = { events: [] };

/**
 * Tunable timeline parameters. Grouped so they're passed as one value and
 * overridable per-instance instead of scattered as module globals.
 */
export interface TimelineConfig {
  /** CSS line height used to normalize wheel `deltaMode: 1` (lines). */
  readonly wheelLineHeight: number;
  /** Zoom sensitivity per normalized pixel of wheel delta. */
  readonly wheelSensitivity: number;
  /** Time scroll sensitivity per normalized pixel of horizontal wheel delta. */
  readonly timeScrollSensitivity: number;
  /** "Now" marker line width (CSS px). */
  readonly nowWidth: number;
  /** "Now" marker stroke color. */
  readonly nowStroke: string;
  /** Minimum on-screen spacing between axis ticks (CSS px). */
  readonly minTickPx: number;
}

export const DEFAULT_TIMELINE_CONFIG: TimelineConfig = {
  wheelLineHeight: 16,
  wheelSensitivity: 0.003,
  timeScrollSensitivity: 3,
  nowWidth: 2,
  // TODO: This should go to a theme object
  nowStroke: "rgba(255, 255, 255, 0.55)",
  minTickPx: DEFAULT_MIN_TICK_PX,
};

export class Timeline {
  private readonly canvas: HTMLCanvasElement;
  private readonly plot: Plot;
  private readonly callbacks: TimelineCallbacks;
  private readonly dataSource: DataSource;
  private readonly eventSource: EventSource;
  private readonly feedColorOf: (feedId: string) => string;
  private readonly config: TimelineConfig;
  private rafId: number | null = null;
  private state: TimelineState;

  // Pan scratch (no allocation in handlers).
  private dragging = false;
  private lastX = 0;

  // Reusable eval-time buffer, grown as needed. Avoids per-frame allocation
  // in the render loop (AGENTS.md §5). Covers the visible width plus padding
  // on both sides so off-screen jumps near the edges still contribute to the
  // wavelet response on screen.
  private evalTime: Float64Array = new Float64Array(0);

  // "Now" marker timer. Armed by `drawNow` to fire at a fixed cadence
  // (timePerPx / SMOOTHING_FACTOR) so the line appears to move smoothly
  // without a 60fps timer. The line is recomputed from Date.now() on each
  // tick, so no phase-locking is needed. Cleared on dispose and re-armed
  // every draw.
  private nowTimer: number | null = null;

  constructor(opts: TimelineOptions) {
    this.canvas = opts.canvas;
    this.dataSource = opts.dataSource;
    this.eventSource = opts.eventSource;
    this.feedColorOf = opts.feedColorOf;
    this.config = { ...DEFAULT_TIMELINE_CONFIG, ...opts.config };
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
    };

    this.bindEvents();
    this.resize();
    // Pull the initial event slice for the starting viewport, then kick the
    // first frame. Subsequent draws are on-demand via reqDraw.
    this.refreshEvents();
    this.reqDraw();
  }

  /**
   * Request a redraw on the next animation frame. Coalesces multiple calls
   * within the same frame into one rAF: state mutations happen synchronously,
   * and the callback reads the latest state at draw time, so ignored calls
   * still get their mutations painted by the one scheduled frame.
   */
  reqDraw(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.draw();
    });
  }

  /**
   * Re-pull the visible event slice from the event source for the current
   * viewport. Cheap (binary-search slice of the broker's sorted array) and
   * safe to call frequently — the broker dedups backfill requests via its
   * in-flight set, mirroring the price broker. Called automatically on
   * viewport changes (pan/zoom/fit) and should be called by the broker's
   * subscriber when new events land.
   */
  refreshEvents(): void {
    const { events } = this.eventSource(this.state.timeRange);
    this.state.events = { events };
    // Hovered index may now be stale (the slice changed); clear it so we
    // don't highlight a wrong index. The next pointermove re-hit-tests.
    this.state.hovered = null;
  }

  /** Replace the visible time range (e.g. fit-to-data). Triggers a redraw. */
  setTimeRange(r: Range): void {
    this.state.timeRange = r;
    this.plot.setTimeRange(r);
    this.refreshEvents();
    this.reqDraw();
  }

  /** Current visible time range. */
  getTimeRange(): Range {
    return this.state.timeRange;
  }

  /** Switch the heatmap color palette by name. Triggers a redraw. */
  setPalette(name: PaletteName): void {
    setRampPalette(name);
    this.reqDraw();
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
    this.reqDraw();
  }

  private onResize = (): void => this.resize();

  /**
   * One-shot draw. Reads the current state and paints a single frame. Called
   * only via `requestRender`, which coalesces multiple requests into one rAF.
   * The loop does not self-reschedule; the "now" marker timer and input
   * handlers re-arm it on demand.
   */
  private draw = (): void => {
    using frame = this.plot.beginFrame();
    const { events, hovered, priceScale, timeRange } = this.state;
    const { width, height, dpr } = frame;

    // Background.
    frame.fillRectPx(0, 0, width, height, "#05070d");

    // Number of device pixels
    const numPx = width * dpr;
    const maxSigma = maxSigmaFor(numPx);
    // timePerPx in *device* pixels (maxSigma is in device pixels).
    const timePerPx = (timeRange.max - timeRange.min) / numPx;

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
    frame.events().drawRow(events, this.feedColorOf, hovered);
    frame.drawTimeAxis(this.config.minTickPx);

    // "Now" marker: a vertical line at the current wall-clock time. `drawNow`
    // arms a timer at a fixed cadence (timePerPx / SMOOTHING_FACTOR) instead of
    // running a 60fps timer. When zoomed out far enough that a pixel spans
    // minutes or hours, the timer fires only every few minutes/hours. When
    // `now` is off-screen, no timer is needed — panning/zooming back into view
    // re-arms it via the redraw path.
    this.drawNow(frame, timePerPx);
  };

  /**
   * Draw the "now" vertical line and arm a timer for the next redraw.
   *
   * The line is drawn at `Date.now()` if it falls within the visible time
   * range. We then schedule a `reqDraw` at a fixed cadence so the line appears
   * to move smoothly without burning a per-frame timer. The timer is cleared
   * and re-armed on every draw, so panning/zooming (which changes the
   * time-per-pixel or moves `now` on/off screen) is handled naturally by the
   * next frame.
   *
   * Cadence: `timePerPx` is the time span per device pixel (the draw loop
   * computes it as span / ceil(width * dpr)). Visibility is defined in device
   * pixels — the canvas rasterizes at device-px resolution, so the line's
   * anti-aliasing changes when its device-px position crosses an integer. On
   * a dpr=2 display, moving 1 CSS px moves the line 2 device px (clearly
   * visible), so CSS px would skip real visible changes. We step
   * SMOOTHING_FACTOR times per device pixel so the line glides instead of
   * jumping (worst-case on 1x displays where 1 device px == 1 CSS px; harmless
   * overkill on high-DPI). This is a taste/battery tradeoff, orthogonal to
   * the device-px unit choice.
   *
   * No phase-locking is needed: the line is recomputed from `Date.now()` on
   * every tick, so its position is always the true wall-clock position — there
   * is no accumulated increment to drift. The timer just needs to fire often
   * enough that the recomputed position doesn't jump more than
   * 1/SMOOTHING_FACTOR of a device pixel between frames.
   */
  private drawNow(frame: Frame, timePerPx: number): void {
    if (this.nowTimer !== null) clearTimeout(this.nowTimer);

    this.nowTimer = null;
    const now = Date.now();
    const { timeRange } = this.state;
    if (now > timeRange.max) return;

    // Position of now, in CSS pixels (timeToX maps to screenDomain = {0, width}).
    const x = frame.tx.timeToX(now);
    frame.vline(x, 0, frame.height, this.config.nowStroke, this.config.nowWidth);

    const SMOOTHING_FACTOR = 10;
    const tillNextChange = timePerPx / SMOOTHING_FACTOR;
    // If `now` is before the visible window, wait for it to enter instead of
    // firing immediately — panning/zooming will re-arm via the redraw path.
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

    const cfg = this.config;
    // Normalize deltaY to pixels across deltaModes.
    let dy = e.deltaY;
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) dy *= cfg.wheelLineHeight;
    else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) dy *= this.plot.cssHeight;
    else if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) dy *= 1;

    // Apply horizontal scrolling
    if (width > 0) {
      const span = this.state.timeRange.max - this.state.timeRange.min;
      const dt = (cfg.timeScrollSensitivity * (span * e.deltaX)) / width;
      this.setTimeRange(Range.pan(this.state.timeRange, dt));
    }

    if (e.shiftKey) {
      this.state.priceScale -= dy * cfg.wheelSensitivity;
      this.reqDraw();
      return;
    }
    const tx = new DataTransform(
      this.state.timeRange,
      Range.create(0, width),
      Range.create(0, this.plot.cssHeight),
    );
    const tFocus = tx.xToTime(px);
    const factor = Math.exp(-dy * cfg.wheelSensitivity);
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
      this.state = { ...this.state, hovered: idx };
      this.reqDraw();
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
      feedId: ev.feedId,
      t: ev.t,
      px,
      py,
    });
  }
}
