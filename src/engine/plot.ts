/** Long-lived canvas resources for the immediate-mode timeline renderer. */

import type { Range } from "./range.ts";
import { Range as R } from "./range.ts";
import { DataTransform } from "./transform.ts";
import { Frame } from "./gfx/context.ts";

export interface PlotOptions {
  readonly canvas: HTMLCanvasElement;
}

/**
 * Plot owns rendering resources only. View state is supplied by the caller for
 * every frame, so there is no second copy of the visible time range to keep in
 * sync with Timeline.
 */
export class Plot {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  /** Reusable per-pixel price buffer. Grows as needed, never shrinks. */
  private scratch = new Float64Array(0);

  constructor(opts: PlotOptions) {
    this.canvas = opts.canvas;
    const ctx = this.canvas.getContext("2d", { alpha: false });
    if (ctx === null) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;
  }

  setDpr(dpr: number): void {
    if (!(dpr > 0) || !Number.isFinite(dpr)) throw new Error(`Invalid device pixel ratio: ${dpr}`);
    this.dpr = dpr;
  }

  get cssWidth(): number {
    return this.canvas.width / this.dpr;
  }

  get cssHeight(): number {
    return this.canvas.height / this.dpr;
  }

  beginFrame(timeRange: Range): Frame {
    const cssWidth = this.cssWidth;
    const cssHeight = this.cssHeight;
    if (!(cssWidth > 0) || !(cssHeight > 0)) {
      throw new Error(`Invalid canvas size: ${cssWidth}x${cssHeight} (dpr=${this.dpr})`);
    }

    const needed = Math.ceil(cssWidth) + 1;
    if (this.scratch.length < needed) this.scratch = new Float64Array(needed);

    return new Frame(
      this.ctx,
      new DataTransform(timeRange, R.create(0, cssWidth), R.create(0, cssHeight)),
      this.scratch,
      this.dpr,
    );
  }
}
