import type { RequestSegment } from "../../data/signal/requests.ts";
import type { Frame } from "./context.ts";
import {
  COVERAGE_BAR_HEIGHT,
  DATA_HEIGHT,
  QUALITY_STEPS,
  REQUEST_HEIGHT,
  REQUEST_UNDERLINE_DEVICE_PX,
} from "./layout.ts";

interface LabelStyle {
  readonly text: string;
  readonly shadow: string;
}

interface RequestStyle extends LabelStyle {
  readonly fill: string;
}

interface StatusBarStyle {
  readonly font: string;
  readonly densityEmpty: string;
  readonly densityFull: string;
  readonly requestEmpty: string;
  readonly divider: string;
  readonly requests: Readonly<Record<RequestSegment["state"], RequestStyle>>;
}

const STYLE_BY_CANVAS = new WeakMap<HTMLCanvasElement, StatusBarStyle>();

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
  private readonly style: StatusBarStyle;

  constructor(private readonly frame: Frame) {
    this.style = statusBarStyle(frame.ctx.canvas);
  }

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

    frame.fillRectPx(0, y, frame.width, DATA_HEIGHT, this.style.densityEmpty);
    let runStart = 0;
    let runIndex = qualityIndex(sampleDensity[0]!);
    for (let x = 1; x <= deviceWidth; x++) {
      const nextIndex = x < deviceWidth ? qualityIndex(sampleDensity[x]!) : -1;
      if (nextIndex === runIndex) continue;
      if (runIndex > 0) {
        const ctx = frame.ctx;
        ctx.save();
        ctx.globalAlpha = qualityStrength(runIndex);
        frame.fillRectPx(
          runStart / frame.dpr,
          y,
          (x - runStart) / frame.dpr,
          DATA_HEIGHT,
          this.style.densityFull,
        );
        ctx.restore();
      }
      runStart = x;
      runIndex = nextIndex;
    }

    frame.fillRectPx(0, y + DATA_HEIGHT, frame.width, REQUEST_HEIGHT, this.style.requestEmpty);
    this.drawRequests(requests, "pending", y);
    const hasVisibleRetry = this.drawRequests(requests, "retrying", y);
    this.drawRequestLabels(requests, y, wallNow);
    frame.fillRectPx(0, y + DATA_HEIGHT, frame.width, 1, this.style.divider);
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
        const underlineHeight = REQUEST_UNDERLINE_DEVICE_PX / frame.dpr;
        const underlineBottom = Math.round((y + COVERAGE_BAR_HEIGHT) * frame.dpr) / frame.dpr;
        frame.fillRectPx(
          x0,
          underlineBottom - underlineHeight,
          x1 - x0,
          underlineHeight,
          this.style.requests[state].fill,
        );
        drew = true;
      }
    }
    return drew;
  }

  private drawRequestLabels(requests: readonly RequestSegment[], y: number, wallNow: number): void {
    const { frame } = this;
    const ctx = frame.ctx;
    ctx.font = this.style.font;
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
      drawLabel(
        frame,
        text,
        labelX,
        y + DATA_HEIGHT + REQUEST_HEIGHT / 2,
        this.style.font,
        this.style.requests[segment.state],
      );
      ctx.restore();
      nextLabelX = labelX + textWidth + 12;
    }
  }
}

function drawLabel(
  frame: Frame,
  text: string,
  x: number,
  centerY: number,
  font: string,
  style: LabelStyle,
): void {
  const ctx = frame.ctx;
  ctx.save();
  ctx.shadowColor = style.shadow;
  ctx.shadowBlur = 2;
  frame.text(text, x, centerY, font, style.text, "left", "middle");
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

function qualityStrength(index: number): number {
  return (index / (QUALITY_STEPS - 1)) ** 0.82;
}

function statusBarStyle(canvas: HTMLCanvasElement): StatusBarStyle {
  const cached = STYLE_BY_CANVAS.get(canvas);
  if (cached !== undefined) return cached;
  const css = getComputedStyle(canvas);
  const read = (name: string): string => {
    const value = css.getPropertyValue(name).trim();
    if (value.length === 0) throw new Error(`Missing canvas style ${name}`);
    return value;
  };
  const style: StatusBarStyle = {
    font: read("--timeline-status-font"),
    densityEmpty: read("--timeline-status-density-empty"),
    densityFull: read("--timeline-status-density-full"),
    requestEmpty: read("--timeline-status-request-empty"),
    divider: read("--timeline-status-divider"),
    requests: {
      pending: {
        fill: read("--timeline-status-pending"),
        text: read("--timeline-status-pending-text"),
        shadow: read("--timeline-status-pending-shadow"),
      },
      retrying: {
        fill: read("--timeline-status-retrying"),
        text: read("--timeline-status-retrying-text"),
        shadow: read("--timeline-status-retrying-shadow"),
      },
    },
  };
  STYLE_BY_CANVAS.set(canvas, style);
  return style;
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
