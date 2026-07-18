import type { Frame } from "./context.ts";
import { COVERAGE_BAR_HEIGHT, QUALITY_STEPS } from "./layout.ts";

interface DensityStyle {
  readonly empty: string;
  readonly full: string;
}

const STYLE_BY_CANVAS = new WeakMap<HTMLCanvasElement, DensityStyle>();

export interface StatusBarLayer {
  draw(sampleDensity: Float64Array, y: number): void;
}

export const StatusBar = {
  create(frame: Frame): StatusBarLayer {
    return new StatusBarImpl(frame);
  },
};

class StatusBarImpl implements StatusBarLayer {
  private readonly style: DensityStyle;

  constructor(private readonly frame: Frame) {
    this.style = densityStyle(frame.ctx.canvas);
  }

  draw(sampleDensity: Float64Array, y: number): void {
    const { frame } = this;
    const deviceWidth = Math.round(frame.width * frame.dpr);
    if (deviceWidth <= 0) return;
    if (sampleDensity.length !== deviceWidth) {
      throw new Error(
        `StatusBar.draw: density width ${sampleDensity.length} does not match ${deviceWidth}`,
      );
    }

    frame.fillRectPx(0, y, frame.width, COVERAGE_BAR_HEIGHT, this.style.empty);
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
          COVERAGE_BAR_HEIGHT,
          this.style.full,
        );
        ctx.restore();
      }
      runStart = x;
      runIndex = nextIndex;
    }
  }
}

function qualityIndex(value: number): number {
  return Math.max(0, Math.min(QUALITY_STEPS - 1, Math.round(value * (QUALITY_STEPS - 1))));
}

function qualityStrength(index: number): number {
  return (index / (QUALITY_STEPS - 1)) ** 0.82;
}

function densityStyle(canvas: HTMLCanvasElement): DensityStyle {
  const cached = STYLE_BY_CANVAS.get(canvas);
  if (cached !== undefined) return cached;
  const css = getComputedStyle(canvas);
  const read = (name: string): string => {
    const value = css.getPropertyValue(name).trim();
    if (value.length === 0) throw new Error(`Missing canvas style ${name}`);
    return value;
  };
  const style = {
    empty: read("--timeline-status-density-empty"),
    full: read("--timeline-status-density-full"),
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
