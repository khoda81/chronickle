import {
  signalReportFrontier,
  type SignalReport,
  type SignalReportKind,
} from "../../data/signal/reports.ts";
import type { Frame } from "./context.ts";
import {
  COVERAGE_BAR_HEIGHT,
  DATA_HEIGHT,
  QUALITY_STEPS,
  REPORT_HEIGHT,
  REPORT_UNDERLINE_DEVICE_PX,
} from "./layout.ts";

interface ReportStyle {
  readonly fill: string;
  readonly text: string;
  readonly shadow: string;
}

interface StatusBarStyle {
  readonly font: string;
  readonly densityEmpty: string;
  readonly densityFull: string;
  readonly reportEmpty: string;
  readonly divider: string;
  readonly reports: Readonly<Record<SignalReportKind, ReportStyle>>;
}

const STYLE_BY_CANVAS = new WeakMap<HTMLCanvasElement, StatusBarStyle>();

export interface StatusBarLayer {
  draw(sampleDensity: Float64Array, reports: readonly SignalReport[], y: number): void;
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

  draw(sampleDensity: Float64Array, reports: readonly SignalReport[], y: number): void {
    const { frame } = this;
    const deviceWidth = Math.round(frame.width * frame.dpr);
    if (deviceWidth <= 0) return;
    if (sampleDensity.length !== deviceWidth) {
      throw new Error(
        `StatusBar.draw: density width ${sampleDensity.length} does not match ${deviceWidth}`,
      );
    }

    this.drawDensity(sampleDensity, deviceWidth, y);
    frame.fillRectPx(0, y + DATA_HEIGHT, frame.width, REPORT_HEIGHT, this.style.reportEmpty);
    this.drawReports(reports, y);
    frame.fillRectPx(0, y + DATA_HEIGHT, frame.width, 1, this.style.divider);
  }

  private drawDensity(sampleDensity: Float64Array, deviceWidth: number, y: number): void {
    const { frame } = this;
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
  }

  private drawReports(reports: readonly SignalReport[], y: number): void {
    const { frame } = this;
    const fragments = signalReportFrontier(reports, frame.tx.timeDomain);
    const underlineHeight = REPORT_UNDERLINE_DEVICE_PX / frame.dpr;
    const underlineBottom = Math.round((y + COVERAGE_BAR_HEIGHT) * frame.dpr) / frame.dpr;
    let nextLabelX = 6;

    frame.ctx.font = this.style.font;
    for (const fragment of fragments) {
      const x0 = Math.max(0, frame.tx.timeToX(fragment.range.start));
      const x1 = Math.min(frame.width, frame.tx.timeToX(fragment.range.end));
      if (!(x1 > x0)) continue;
      const reportStyle = this.style.reports[fragment.report.kind];
      frame.fillRectPx(
        x0,
        underlineBottom - underlineHeight,
        x1 - x0,
        underlineHeight,
        reportStyle.fill,
      );

      const labelX = Math.max(x0 + 6, nextLabelX);
      const text = ellipsize(frame.ctx, fragment.report.message, x1 - labelX - 6);
      if (text.length === 0) continue;
      const textWidth = Math.ceil(frame.ctx.measureText(text).width);
      frame.ctx.save();
      frame.ctx.beginPath();
      frame.ctx.rect(x0, y + DATA_HEIGHT, x1 - x0, REPORT_HEIGHT);
      frame.ctx.clip();
      frame.ctx.shadowColor = reportStyle.shadow;
      frame.ctx.shadowBlur = 2;
      frame.text(
        text,
        labelX,
        y + DATA_HEIGHT + REPORT_HEIGHT / 2,
        this.style.font,
        reportStyle.text,
        "left",
        "middle",
      );
      frame.ctx.restore();
      nextLabelX = labelX + textWidth + 12;
    }
  }
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (!(maxWidth > 0)) return "";
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
    reportEmpty: read("--timeline-status-report-empty"),
    divider: read("--timeline-status-divider"),
    reports: {
      info: {
        fill: read("--timeline-report-info"),
        text: read("--timeline-report-info-text"),
        shadow: read("--timeline-report-info-shadow"),
      },
      warn: {
        fill: read("--timeline-report-warn"),
        text: read("--timeline-report-warn-text"),
        shadow: read("--timeline-report-warn-shadow"),
      },
      error: {
        fill: read("--timeline-report-error"),
        text: read("--timeline-report-error-text"),
        shadow: read("--timeline-report-error-shadow"),
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
