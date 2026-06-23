/**
 * Plot — the long-lived renderer state.
 *
 * Owns only what must survive between frames:
 *   - the canvas (and its cached 2D context),
 *   - the current time range (the plot's persistent state),
 *   - the device pixel ratio (updated on resize),
 *   - a reusable, resizable scratch buffer for the heatmap's per-pixel work.
 *
 * Everything else — the transform, the frame, the data — is computed fresh
 * each frame from the arguments passed to `draw(...)`. The plot does not
 * store the series, events, or hover state; those are pushed in per draw.
 *
 * `draw(...)` returns a disposable `Frame` (use with `using`). The frame
 * applies the DPR-scaled transform on construction and restores it on
 * dispose, so caller-side ctx state is never disturbed.
 */

import type { Range } from "./range.ts";
import { Range as R } from "./range.ts";
import { DataTransform } from "./transform.ts";
import { Frame } from "./gfx/context.ts";

export interface PlotOptions {
  readonly canvas: HTMLCanvasElement;
  readonly initialTimeRange: Range;
}

export class Plot {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private timeRange: Range;
  private dpr = 1;
  /** Reusable per-pixel price buffer. Grows as needed, never shrinks. */
  private scratch: Float64Array = new Float64Array(0);

  constructor(opts: PlotOptions) {
    this.canvas = opts.canvas;
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (ctx === null) {
      throw new Error("Canvas 2D context unavailable");
    }
    this.ctx = ctx;
    this.timeRange = opts.initialTimeRange;
  }

  /** Replace the visible time range. */
  setTimeRange(r: Range): void {
    this.timeRange = r;
  }

  /** Current visible time range. */
  getTimeRange(): Range {
    return this.timeRange;
  }

  /** Update the device pixel ratio (call on resize). */
  setDpr(dpr: number): void {
    this.dpr = dpr;
  }

  /** CSS pixel width of the canvas backing store at the current DPR. */
  get cssWidth(): number {
    return this.canvas.width / this.dpr;
  }

  /** CSS pixel height of the canvas backing store at the current DPR. */
  get cssHeight(): number {
    return this.canvas.height / this.dpr;
  }

  /**
   * Begin a frame. Returns a disposable `Frame` whose transform maps the
   * current time range to the canvas's CSS-pixel size at device resolution.
   *
   * The caller drives all drawing through the frame (immediate mode); the
   * plot does not draw anything itself. Width/height/time range are read
   * fresh each call — nothing about the frame is cached.
   *
   * Throws if the canvas has a non-positive CSS size.
   */
  beginFrame(): Frame {
    const cssWidth = this.cssWidth;
    const cssHeight = this.cssHeight;
    if (!(cssWidth > 0) || !(cssHeight > 0)) {
      throw new Error(`Invalid canvas size: ${cssWidth}x${cssHeight} (dpr=${this.dpr})`);
    }

    // Ensure scratch can hold width+1 samples (heatmap per-pixel buffer).
    const needed = Math.ceil(cssWidth) + 1;
    if (this.scratch.length < needed) {
      this.scratch = new Float64Array(needed);
    }

    const tx = new DataTransform(this.timeRange, R.create(0, cssWidth), R.create(0, cssHeight));

    return new Frame(this.ctx, tx, this.scratch, this.dpr);
  }
}
