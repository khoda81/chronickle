import type { ResolutionSegment } from "../../data/price/coverage.ts";
import { rampCss, rampIndex, rampLut, type PaletteName } from "../ramp.ts";
import type { Frame } from "./context.ts";
import { RESOLUTION_BAR_HEIGHT } from "./layout.ts";

export interface ResolutionLayer {
  draw(
    segments: readonly ResolutionSegment[],
    targetResolutionMs: number,
    y: number,
    palette: PaletteName,
  ): void;
}

export const Resolution = {
  create(frame: Frame): ResolutionLayer {
    return new ResolutionImpl(frame);
  },
};

class ResolutionImpl implements ResolutionLayer {
  constructor(private readonly frame: Frame) {}

  draw(
    segments: readonly ResolutionSegment[],
    targetResolutionMs: number,
    y: number,
    palette: PaletteName,
  ): void {
    const { frame } = this;
    const width = Math.ceil(frame.width);
    if (width <= 0) return;
    const quality = frame.scratch;
    quality.fill(0, 0, width);

    // Ready evidence composes by maximum quality. Empty ranges remain exactly
    // zero, so they can never paint over overlapping ready data.
    for (const segment of segments) {
      if (segment.state !== "ready") continue;
      const x0 = Math.max(0, Math.floor(frame.tx.timeToX(segment.range.min)));
      const x1 = Math.min(width, Math.ceil(frame.tx.timeToX(segment.range.max)));
      if (!(x1 > x0)) continue;
      const value = Math.min(1, targetResolutionMs / segment.resolutionMs);
      for (let x = x0; x < x1; x++) quality[x] = Math.max(quality[x]!, value);
    }

    const lut = rampLut(palette);
    let runStart = 0;
    let runIndex = rampIndex(quality[0]!);
    for (let x = 1; x <= width; x++) {
      const nextIndex = x < width ? rampIndex(quality[x]!) : -1;
      if (nextIndex === runIndex) continue;
      frame.fillRectPx(runStart, y, x - runStart, RESOLUTION_BAR_HEIGHT, rampCss(lut, runIndex));
      runStart = x;
      runIndex = nextIndex;
    }

    // Loading and failure are request state, not sample quality. Keep them as
    // compact overlays without replacing the quality color underneath.
    for (const segment of segments) {
      if (segment.state !== "pending" && segment.state !== "failed") continue;
      const x0 = Math.max(0, frame.tx.timeToX(segment.range.min));
      const x1 = Math.min(frame.width, frame.tx.timeToX(segment.range.max));
      if (!(x1 > x0)) continue;
      frame.fillRectPx(
        x0,
        segment.state === "failed" ? y : y + RESOLUTION_BAR_HEIGHT - 2,
        x1 - x0,
        2,
        segment.state === "failed" ? "rgba(248, 113, 113, 0.95)" : "rgba(250, 204, 21, 0.95)",
      );
    }

    frame.fillRectPx(0, y, frame.width, 1, "rgba(255,255,255,0.18)");
  }
}
