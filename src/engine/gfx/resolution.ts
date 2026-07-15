import type { CoverageSegment } from "../../data/signal/coverage.ts";
import type { Frame } from "./context.ts";
import { COVERAGE_BAR_HEIGHT } from "./layout.ts";

const QUALITY_STEPS = 256;
const QUALITY_COLORS = buildQualityColors();
const FONT = "10px ui-monospace, monospace";
const TEXT_Y_OFFSET = COVERAGE_BAR_HEIGHT / 2;

export interface ResolutionLayer {
  draw(segments: readonly CoverageSegment[], targetResolutionMs: number, y: number): void;
}

export const CoverageBar = {
  create(frame: Frame): ResolutionLayer {
    return new ResolutionImpl(frame);
  },
};

class ResolutionImpl implements ResolutionLayer {
  constructor(private readonly frame: Frame) {}

  draw(segments: readonly CoverageSegment[], targetResolutionMs: number, y: number): void {
    const { frame } = this;
    const width = Math.ceil(frame.width);
    if (width <= 0) return;
    const quality = frame.scratch;
    quality.fill(0, 0, width);

    // Ready evidence composes by maximum quality. Missing/empty ranges stay at
    // zero, so an empty search can never obscure overlapping usable data.
    for (const segment of segments) {
      if (segment.state !== "ready") continue;
      const x0 = Math.max(0, Math.floor(frame.tx.timeToX(segment.range.min)));
      const x1 = Math.min(width, Math.ceil(frame.tx.timeToX(segment.range.max)));
      if (!(x1 > x0)) continue;
      const value = Math.min(1, targetResolutionMs / segment.samplePeriodMs);
      for (let x = x0; x < x1; x++) quality[x] = Math.max(quality[x]!, value);
    }

    let runStart = 0;
    let runIndex = qualityIndex(quality[0]!);
    for (let x = 1; x <= width; x++) {
      const nextIndex = x < width ? qualityIndex(quality[x]!) : -1;
      if (nextIndex === runIndex) continue;
      frame.fillRectPx(runStart, y, x - runStart, COVERAGE_BAR_HEIGHT, QUALITY_COLORS[runIndex]!);
      runStart = x;
      runIndex = nextIndex;
    }

    // Request state is orthogonal to cached quality. Keep it as a thin,
    // unmistakable overlay instead of replacing the underlying resolution.
    for (const segment of segments) {
      if (segment.state !== "pending" && segment.state !== "watching" && segment.state !== "failed")
        continue;
      const x0 = Math.max(0, frame.tx.timeToX(segment.range.min));
      const x1 = Math.min(frame.width, frame.tx.timeToX(segment.range.max));
      if (!(x1 > x0)) continue;
      frame.fillRectPx(
        x0,
        segment.state === "failed" ? y : y + COVERAGE_BAR_HEIGHT - 3,
        x1 - x0,
        3,
        segment.state === "failed"
          ? "rgba(248, 113, 113, 0.98)"
          : segment.state === "watching"
            ? "rgba(45, 212, 191, 0.98)"
            : "rgba(250, 204, 21, 0.98)",
      );
    }

    this.drawLabels(segments, targetResolutionMs, y);
    frame.fillRectPx(0, y, frame.width, 1, "rgba(255,255,255,0.18)");
  }

  private drawLabels(
    segments: readonly CoverageSegment[],
    targetResolutionMs: number,
    y: number,
  ): void {
    const { frame } = this;
    const ctx = frame.ctx;
    ctx.font = FONT;

    const targetText = `target ${formatResolution(targetResolutionMs)}`;
    const targetWidth = Math.ceil(ctx.measureText(targetText).width);
    const targetLeft = Math.max(4, frame.width - targetWidth - 8);
    drawLabel(frame, targetText, targetLeft, y, "#e2e8f0");

    let nextLabelX = 5;
    const labelLimit = targetLeft - 7;
    for (const segment of segments) {
      const x0 = Math.max(0, frame.tx.timeToX(segment.range.min));
      const x1 = Math.min(labelLimit, frame.tx.timeToX(segment.range.max));
      if (!(x1 > x0)) continue;
      const text = segmentLabel(segment);
      const textWidth = Math.ceil(ctx.measureText(text).width);
      const labelX = Math.max(x0 + 4, nextLabelX);
      if (labelX + textWidth + 4 > x1) continue;
      drawLabel(frame, text, labelX, y, labelColor(segment.state));
      nextLabelX = labelX + textWidth + 10;
    }
  }
}

function drawLabel(frame: Frame, text: string, x: number, y: number, color: string): void {
  const width = Math.ceil(frame.ctx.measureText(text).width);
  frame.fillRectPx(x - 3, y + 2, width + 6, COVERAGE_BAR_HEIGHT - 4, "rgba(5,7,13,0.7)");
  frame.text(text, x, y + TEXT_Y_OFFSET, FONT, color, "left", "middle");
}

function segmentLabel(segment: CoverageSegment): string {
  switch (segment.state) {
    case "ready":
      return `ready ${formatResolution(segment.samplePeriodMs)}`;
    case "empty":
      return "no data";
    case "pending":
      return `loading ${formatResolution(segment.samplePeriodMs)}`;
    case "watching":
      return `live ${formatResolution(segment.samplePeriodMs)}`;
    case "failed":
      return segment.message === undefined
        ? `error ${formatResolution(segment.samplePeriodMs)}`
        : `error · ${segment.message}`;
  }
}

function labelColor(state: CoverageSegment["state"]): string {
  if (state === "pending") return "#fde68a";
  if (state === "watching") return "#99f6e4";
  if (state === "failed") return "#fecaca";
  return "#f8fafc";
}

function qualityIndex(value: number): number {
  return Math.max(0, Math.min(QUALITY_STEPS - 1, Math.round(value * (QUALITY_STEPS - 1))));
}

function buildQualityColors(): readonly string[] {
  const low = [6, 9, 15] as const;
  const high = [167, 243, 208] as const;
  return Array.from({ length: QUALITY_STEPS }, (_, index) => {
    const t = index / (QUALITY_STEPS - 1);
    const curved = t ** 0.72;
    const r = Math.round(low[0] + (high[0] - low[0]) * curved);
    const g = Math.round(low[1] + (high[1] - low[1]) * curved);
    const b = Math.round(low[2] + (high[2] - low[2]) * curved);
    return `rgb(${r} ${g} ${b})`;
  });
}

function formatResolution(ms: number): string {
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms >= 1_000 && ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${Math.round(ms)}ms`;
}
