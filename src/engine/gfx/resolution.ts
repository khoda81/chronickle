import type { RequestSegment } from "../../data/signal/requests.ts";
import type { Frame } from "./context.ts";
import { COVERAGE_BAR_HEIGHT } from "./layout.ts";

const QUALITY_STEPS = 256;
const FONT = "9px ui-monospace, monospace";
/** Vertical height in CSS pixels; density bins themselves are one device pixel wide. */
const DATA_HEIGHT = 4;
const REQUEST_HEIGHT = COVERAGE_BAR_HEIGHT - DATA_HEIGHT;
const LIGHT_TEXT = "#f3f8fc";
const QUALITY_PALETTE = buildQualityPalette();

const REQUEST_FILL = { pending: "rgb(61 70 85)", retrying: "rgb(132 48 61)" } as const;

export interface StatusBarLayer {
  /** True when a visible retry countdown needs another clock redraw. */
  draw(
    sampleDensity: Float64Array,
    requests: readonly RequestSegment[],
    y: number,
    wallNow: number,
  ): boolean;
}

export const StatusBar = {
  create(frame: Frame): StatusBarLayer {
    return new StatusBarImpl(frame);
  },
};

class StatusBarImpl implements StatusBarLayer {
  constructor(private readonly frame: Frame) {}

  draw(
    sampleDensity: Float64Array,
    requests: readonly RequestSegment[],
    y: number,
    wallNow: number,
  ): boolean {
    const { frame } = this;
    const deviceWidth = Math.round(frame.width * frame.dpr);
    if (deviceWidth <= 0) return false;
    if (sampleDensity.length !== deviceWidth) {
      throw new Error(
        `StatusBar.draw: density width ${sampleDensity.length} does not match ${deviceWidth}`,
      );
    }

    let runStart = 0;
    let runIndex = qualityIndex(sampleDensity[0]!);
    for (let x = 1; x <= deviceWidth; x++) {
      const nextIndex = x < deviceWidth ? qualityIndex(sampleDensity[x]!) : -1;
      if (nextIndex === runIndex) continue;
      frame.fillRectPx(
        runStart / frame.dpr,
        y,
        (x - runStart) / frame.dpr,
        DATA_HEIGHT,
        QUALITY_PALETTE.colors[runIndex]!,
      );
      runStart = x;
      runIndex = nextIndex;
    }

    frame.fillRectPx(0, y + DATA_HEIGHT, frame.width, REQUEST_HEIGHT, "rgb(11 17 27)");
    this.drawRequests(requests, "pending", y);
    const hasVisibleRetry = this.drawRequests(requests, "retrying", y);
    this.drawRequestLabels(requests, y, wallNow);
    frame.fillRectPx(0, y + DATA_HEIGHT, frame.width, 1, "rgba(255, 255, 255, 0.18)");
    frame.fillRectPx(0, y + COVERAGE_BAR_HEIGHT - 1, frame.width, 1, "rgba(2, 6, 12, 0.38)");
    return hasVisibleRetry;
  }

  private drawRequests(
    requests: readonly RequestSegment[],
    state: RequestSegment["state"],
    y: number,
  ): boolean {
    const { frame } = this;
    let drew = false;
    for (const segment of requests) {
      if (segment.state !== state) continue;
      const x0 = Math.max(0, frame.tx.timeToX(segment.range.start));
      const x1 = Math.min(frame.width, frame.tx.timeToX(segment.range.end));
      if (x1 > x0) {
        frame.fillRectPx(x0, y + DATA_HEIGHT, x1 - x0, REQUEST_HEIGHT, REQUEST_FILL[state]);
        drew = true;
      }
    }
    return drew;
  }

  private drawRequestLabels(requests: readonly RequestSegment[], y: number, wallNow: number): void {
    const { frame } = this;
    const ctx = frame.ctx;
    ctx.font = FONT;
    let nextLabelX = 6;
    for (const segment of requests) {
      const x0 = Math.max(0, frame.tx.timeToX(segment.range.start));
      const x1 = Math.min(frame.width, frame.tx.timeToX(segment.range.end));
      if (!(x1 > x0)) continue;
      const labelX = Math.max(x0 + 6, nextLabelX);
      const availableWidth = x1 - labelX - 6;
      if (!(availableWidth > 0)) continue;
      const text = ellipsize(ctx, requestLabel(segment, wallNow), availableWidth);
      if (text.length === 0) continue;
      const textWidth = Math.ceil(ctx.measureText(text).width);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y + DATA_HEIGHT, x1 - x0, REQUEST_HEIGHT);
      ctx.clip();
      drawLabel(frame, text, labelX, y + DATA_HEIGHT + REQUEST_HEIGHT / 2, LIGHT_TEXT);
      ctx.restore();
      nextLabelX = labelX + textWidth + 12;
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

function requestLabel(segment: RequestSegment, wallNow: number): string {
  const resolution = formatResolution(segment.samplePeriodMs);
  switch (segment.state) {
    case "pending":
      return `fetching · ${resolution} spacing`;
    case "retrying": {
      const delay = formatResolution(Math.floor((segment.retryAtMs - wallNow) / 1000) * 1000);
      return `retrying · ${resolution} spacing · in ${delay} #${segment.attempt} · ${segment.message}`;
    }
  }
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const suffix = "…";
  if (ctx.measureText(suffix).width > maxWidth) return "";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + suffix).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + suffix;
}

function qualityIndex(value: number): number {
  return Math.max(0, Math.min(QUALITY_STEPS - 1, Math.round(value * (QUALITY_STEPS - 1))));
}

function buildQualityPalette(): { readonly colors: readonly string[] } {
  const low = [8, 13, 23] as const;
  const high = [118, 130, 145] as const;
  const colors: string[] = [];
  for (let index = 0; index < QUALITY_STEPS; index++) {
    const t = index / (QUALITY_STEPS - 1);
    const curved = t ** 0.82;
    const r = Math.round(low[0] + (high[0] - low[0]) * curved);
    const g = Math.round(low[1] + (high[1] - low[1]) * curved);
    const b = Math.round(low[2] + (high[2] - low[2]) * curved);
    colors.push(`rgb(${r} ${g} ${b})`);
  }
  return { colors };
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
