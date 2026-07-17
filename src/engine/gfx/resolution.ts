import type { CoverageSegment } from "../../data/signal/coverage.ts";
import type { Frame } from "./context.ts";
import { COVERAGE_BAR_HEIGHT } from "./layout.ts";

const QUALITY_STEPS = 256;
const FONT = "10px ui-monospace, monospace";
const TEXT_Y_OFFSET = COVERAGE_BAR_HEIGHT / 2;
const LIGHT_TEXT = "#f3f8fc";
const DARK_TEXT = "#071019";
const QUALITY_PALETTE = buildQualityPalette();

const REQUEST_STROKE = {
  pending: "rgba(147, 197, 253, 0.68)",
  watching: "rgba(103, 232, 249, 0.68)",
  failed: "rgba(251, 113, 133, 0.72)",
} as const;

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
      const x0 = Math.max(0, Math.floor(frame.tx.timeToX(segment.range.start)));
      const x1 = Math.min(width, Math.ceil(frame.tx.timeToX(segment.range.end)));
      if (!(x1 > x0)) continue;
      const value = Math.min(1, targetResolutionMs / segment.samplePeriodMs);
      for (let x = x0; x < x1; x++) quality[x] = Math.max(quality[x]!, value);
    }

    let runStart = 0;
    let runIndex = qualityIndex(quality[0]!);
    for (let x = 1; x <= width; x++) {
      const nextIndex = x < width ? qualityIndex(quality[x]!) : -1;
      if (nextIndex === runIndex) continue;
      frame.fillRectPx(
        runStart,
        y,
        x - runStart,
        COVERAGE_BAR_HEIGHT,
        QUALITY_PALETTE.colors[runIndex]!,
      );
      runStart = x;
      runIndex = nextIndex;
    }

    // Request state is orthogonal to cached quality. A quiet glassy edge keeps
    // activity legible without replacing the underlying resolution signal.
    for (const segment of segments) {
      if (segment.state !== "pending" && segment.state !== "watching" && segment.state !== "failed")
        continue;
      const x0 = Math.max(0, frame.tx.timeToX(segment.range.start));
      const x1 = Math.min(frame.width, frame.tx.timeToX(segment.range.end));
      if (!(x1 > x0)) continue;
      const failed = segment.state === "failed";
      frame.fillRectPx(
        x0,
        failed ? y : y + COVERAGE_BAR_HEIGHT - 2,
        x1 - x0,
        2,
        REQUEST_STROKE[segment.state],
      );
    }

    this.drawLabels(segments, targetResolutionMs, quality, y);
    frame.fillRectPx(0, y, frame.width, 1, "rgba(255, 255, 255, 0.16)");
    frame.fillRectPx(0, y + COVERAGE_BAR_HEIGHT - 1, frame.width, 1, "rgba(2, 6, 12, 0.38)");
  }

  private drawLabels(
    segments: readonly CoverageSegment[],
    targetResolutionMs: number,
    quality: Float64Array,
    y: number,
  ): void {
    const { frame } = this;
    const ctx = frame.ctx;
    ctx.font = FONT;

    const targetText = `target ${formatResolution(targetResolutionMs)}`;
    const targetWidth = Math.ceil(ctx.measureText(targetText).width);
    const targetLeft = Math.max(4, frame.width - targetWidth - 8);
    drawLabel(frame, targetText, targetLeft, y, textColorAt(quality, targetLeft + targetWidth / 2));

    let nextLabelX = 5;
    const labelLimit = targetLeft - 7;
    for (const segment of segments) {
      const x0 = Math.max(0, frame.tx.timeToX(segment.range.start));
      const x1 = Math.min(labelLimit, frame.tx.timeToX(segment.range.end));
      if (!(x1 > x0)) continue;
      const text = segmentLabel(segment);
      const textWidth = Math.ceil(ctx.measureText(text).width);
      const labelX = Math.max(x0 + 4, nextLabelX);
      if (labelX + textWidth + 4 > x1) continue;
      drawLabel(frame, text, labelX, y, textColorAt(quality, labelX + textWidth / 2));
      nextLabelX = labelX + textWidth + 10;
    }
  }
}

function drawLabel(frame: Frame, text: string, x: number, y: number, color: string): void {
  const ctx = frame.ctx;
  ctx.save();
  ctx.shadowColor = color === LIGHT_TEXT ? "rgba(0, 0, 0, 0.68)" : "rgba(255, 255, 255, 0.34)";
  ctx.shadowBlur = 2;
  frame.text(text, x, y + TEXT_Y_OFFSET, FONT, color, "left", "middle");
  ctx.restore();
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
      return `error · ${segment.message}`;
  }
}

function textColorAt(quality: Float64Array, x: number): string {
  if (quality.length === 0) return LIGHT_TEXT;
  const index = Math.max(0, Math.min(quality.length - 1, Math.floor(x)));
  return QUALITY_PALETTE.text[qualityIndex(quality[index]!)]!;
}

function qualityIndex(value: number): number {
  return Math.max(0, Math.min(QUALITY_STEPS - 1, Math.round(value * (QUALITY_STEPS - 1))));
}

function buildQualityPalette(): {
  readonly colors: readonly string[];
  readonly text: readonly string[];
} {
  const low = [8, 13, 23] as const;
  const high = [126, 188, 208] as const;
  const colors: string[] = [];
  const text: string[] = [];
  for (let index = 0; index < QUALITY_STEPS; index++) {
    const t = index / (QUALITY_STEPS - 1);
    const curved = t ** 0.82;
    const r = Math.round(low[0] + (high[0] - low[0]) * curved);
    const g = Math.round(low[1] + (high[1] - low[1]) * curved);
    const b = Math.round(low[2] + (high[2] - low[2]) * curved);
    colors.push(`rgb(${r} ${g} ${b})`);
    text.push(contrastText(r, g, b));
  }
  return { colors, text };
}

function contrastText(r: number, g: number, b: number): string {
  const background = relativeLuminance(r, g, b);
  const lightContrast = 1.05 / (background + 0.05);
  const darkContrast = (background + 0.05) / 0.05;
  return lightContrast >= darkContrast ? LIGHT_TEXT : DARK_TEXT;
}

function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
}

function linearChannel(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

export function formatResolution(ms: number): string {
  const magnitude = Math.abs(ms);
  if (!Number.isFinite(magnitude)) return "—";
  if (magnitude < 1_000) return `${Math.round(ms)}ms`;
  if (magnitude < 60_000) return `${formatScaled(ms / 1_000)}s`;
  if (magnitude < 3_600_000) return `${formatScaled(ms / 60_000)}m`;
  if (magnitude < 86_400_000) return `${formatScaled(ms / 3_600_000)}h`;
  return `${formatScaled(ms / 86_400_000)}d`;
}

function formatScaled(value: number): string {
  const magnitude = Math.abs(value);
  const factor = magnitude < 10 ? 100 : magnitude < 100 ? 10 : 1;
  return String(Math.round(value * factor) / factor);
}
