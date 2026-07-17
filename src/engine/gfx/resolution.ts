import type { CoverageSegment } from "../../data/signal/coverage.ts";
import type { Frame } from "./context.ts";
import { COVERAGE_BAR_HEIGHT } from "./layout.ts";

const QUALITY_STEPS = 256;
const FONT = "9px ui-monospace, monospace";
const DATA_HEIGHT = 15;
const REQUEST_HEIGHT = COVERAGE_BAR_HEIGHT - DATA_HEIGHT;
const LIGHT_TEXT = "#f3f8fc";
const DARK_TEXT = "#071019";
const QUALITY_PALETTE = buildQualityPalette();

const DATA_FILL = { held: "rgb(39 52 65)", empty: "rgb(78 49 43)" } as const;

const REQUEST_FILL = {
  pending: "rgb(46 77 105)",
  fetching: "rgb(31 112 127)",
  retrying: "rgb(132 48 61)",
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
  constructor(private readonly frame: Frame) { }

  draw(segments: readonly CoverageSegment[], targetResolutionMs: number, y: number): void {
    const { frame } = this;
    const width = Math.ceil(frame.width);
    if (width <= 0) return;
    const quality = frame.scratch;
    quality.fill(0, 0, width);

    // The upper band is the selected reconstruction. Fresh observations use
    // the quality ramp; stale held values and searched-empty ranges are
    // deliberately distinct instead of both pretending to be "ready".
    for (const segment of segments) {
      if (segment.kind !== "data" || segment.state !== "ready") continue;
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
      frame.fillRectPx(runStart, y, x - runStart, DATA_HEIGHT, QUALITY_PALETTE.colors[runIndex]!);
      runStart = x;
      runIndex = nextIndex;
    }

    for (const segment of segments) {
      if (segment.kind !== "data" || segment.state === "ready") continue;
      const x0 = Math.max(0, frame.tx.timeToX(segment.range.start));
      const x1 = Math.min(frame.width, frame.tx.timeToX(segment.range.end));
      if (!(x1 > x0)) continue;
      frame.fillRectPx(x0, y, x1 - x0, DATA_HEIGHT, DATA_FILL[segment.state]);
    }

    // The lower band is acquisition only. Full-height fills make queued work
    // and retry failures visible instead of reducing them to a two-pixel edge.
    frame.fillRectPx(0, y + DATA_HEIGHT, frame.width, REQUEST_HEIGHT, "rgb(11 17 27)");
    for (const segment of segments) {
      if (segment.kind !== "request") continue;
      const x0 = Math.max(0, frame.tx.timeToX(segment.range.start));
      const x1 = Math.min(frame.width, frame.tx.timeToX(segment.range.end));
      if (!(x1 > x0)) continue;
      frame.fillRectPx(x0, y + DATA_HEIGHT, x1 - x0, REQUEST_HEIGHT, REQUEST_FILL[segment.state]);
    }

    this.drawLabels(segments, targetResolutionMs, quality, y, Date.now());
    frame.fillRectPx(0, y, frame.width, 1, "rgba(255, 255, 255, 0.16)");
    frame.fillRectPx(0, y + DATA_HEIGHT, frame.width, 1, "rgba(255, 255, 255, 0.18)");
    frame.fillRectPx(0, y + COVERAGE_BAR_HEIGHT - 1, frame.width, 1, "rgba(2, 6, 12, 0.38)");
  }

  private drawLabels(
    segments: readonly CoverageSegment[],
    targetResolutionMs: number,
    quality: Float64Array,
    y: number,
    wallNow: number,
  ): void {
    const { frame } = this;
    const ctx = frame.ctx;
    ctx.font = FONT;

    const targetText = `target ${formatResolution(targetResolutionMs)}`;
    const targetWidth = Math.ceil(ctx.measureText(targetText).width);
    const targetLeft = Math.max(4, frame.width - targetWidth - 8);
    const labelColor = textColorAt(quality, targetLeft + targetWidth / 2)
    drawLabel(frame, targetText, targetLeft, y + DATA_HEIGHT / 2, labelColor);

    const labelLimit = targetLeft - 7;
    this.drawSegmentLabels(segments, "data", 5, labelLimit, y + DATA_HEIGHT / 2, quality, wallNow);
    this.drawSegmentLabels(
      segments,
      "request",
      5,
      frame.width - 5,
      y + DATA_HEIGHT + REQUEST_HEIGHT / 2,
      quality,
      wallNow,
    );
  }

  private drawSegmentLabels(
    segments: readonly CoverageSegment[],
    kind: CoverageSegment["kind"],
    startX: number,
    limitX: number,
    centerY: number,
    quality: Float64Array,
    wallNow: number,
  ): void {
    const { frame } = this;
    const ctx = frame.ctx;
    let nextLabelX = startX;
    for (const segment of segments) {
      if (segment.kind !== kind) continue;
      const x0 = Math.max(0, frame.tx.timeToX(segment.range.start));
      const x1 = Math.min(limitX, frame.tx.timeToX(segment.range.end));
      if (!(x1 > x0)) continue;
      let text = segmentLabel(segment, wallNow, false);
      let textWidth = Math.ceil(ctx.measureText(text).width);
      const labelX = Math.max(x0 + 4, nextLabelX);
      if (labelX + textWidth + 4 > x1) {
        text = segmentLabel(segment, wallNow, true);
        textWidth = Math.ceil(ctx.measureText(text).width);
      }
      if (labelX + textWidth + 4 > x1) continue;
      const color =
        segment.kind === "data" && segment.state === "ready"
          ? textColorAt(quality, labelX + textWidth / 2)
          : LIGHT_TEXT;
      drawLabel(frame, text, labelX, centerY, color);
      nextLabelX = labelX + textWidth + 10;
    }
  }
}

function drawLabel(frame: Frame, text: string, x: number, centerY: number, color: string): void {
  const ctx = frame.ctx;
  ctx.save();
  ctx.shadowColor = color === LIGHT_TEXT ? "rgba(0, 0, 0, 0.68)" : "rgba(255, 255, 255, 0.34)";
  ctx.shadowBlur = 2;
  frame.text(text, x, centerY, FONT, color, "left", "middle");
  ctx.restore();
}

function segmentLabel(segment: CoverageSegment, wallNow: number, compact: boolean): string {
  const resolution = formatResolution(segment.samplePeriodMs);
  switch (segment.state) {
    case "ready":
      return compact ? resolution : `ready ${resolution}`;
    case "held":
      return compact ? "held" : `held ${resolution}`;
    case "empty":
      return compact ? "empty" : "no samples";
    case "pending":
      return compact ? "pending" : `pending ${resolution}`;
    case "fetching":
      return compact
        ? "fetching"
        : `fetching ${resolution}${segment.attempt > 0 ? ` #${segment.attempt + 1}` : ""}`;
    case "retrying": {
      const delay = formatResolution(Math.max(0, segment.retryAtMs - wallNow));
      return compact
        ? `retry ${delay}`
        : `retry ${resolution} in ${delay} #${segment.attempt} · ${segment.message}`;
    }
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
