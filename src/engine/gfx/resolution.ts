import type { ResolutionSegment } from "../../data/price/coverage.ts";
import type { Frame } from "./context.ts";
import { RESOLUTION_BAR_HEIGHT } from "./layout.ts";

const COLORS = {
  ready: "rgba(45, 212, 191, 0.82)",
  pending: "rgba(250, 204, 21, 0.88)",
  failed: "rgba(248, 113, 113, 0.92)",
  empty: "rgba(107, 114, 128, 0.70)",
} as const;

const LABEL_COLORS = {
  ready: "#052e2b",
  pending: "#302600",
  failed: "#3f0909",
  empty: "#f8fafc",
} as const;

export interface ResolutionLayer {
  draw(segments: readonly ResolutionSegment[], targetResolutionMs: number, y: number): void;
}

export const Resolution = {
  create(frame: Frame): ResolutionLayer {
    return new ResolutionImpl(frame);
  },
};

class ResolutionImpl implements ResolutionLayer {
  constructor(private readonly frame: Frame) {}

  draw(segments: readonly ResolutionSegment[], targetResolutionMs: number, y: number): void {
    const { frame } = this;
    frame.fillRectPx(0, y, frame.width, RESOLUTION_BAR_HEIGHT, "#0a0e17");

    // Finer samples are taller. The broker orders coarse before fine, so finer
    // evidence covers coarser evidence while pending/failed state remains
    // visibly layered above ready/empty state.
    for (let rank = 0; rank < 3; rank++) {
      for (const segment of segments) {
        if (stateRank(segment.state) !== rank) continue;
        const x0 = Math.max(0, frame.tx.timeToX(segment.range.min));
        const x1 = Math.min(frame.width, frame.tx.timeToX(segment.range.max));
        if (!(x1 > x0)) continue;
        const barHeight = resolutionHeight(segment.resolutionMs);
        frame.fillRectPx(
          x0,
          y + RESOLUTION_BAR_HEIGHT - barHeight,
          x1 - x0,
          barHeight,
          COLORS[segment.state],
        );
        if (x1 - x0 >= 64) {
          const detail =
            segment.state === "failed" && segment.message !== undefined && x1 - x0 >= 180
              ? ` · ${segment.message}`
              : "";
          frame.text(
            `${segment.state} ${formatResolution(segment.resolutionMs)}${detail}`,
            x0 + 4,
            y + RESOLUTION_BAR_HEIGHT - 5,
            "10px ui-monospace, monospace",
            LABEL_COLORS[segment.state],
          );
        }
      }
    }

    frame.fillRectPx(0, y, frame.width, 1, "rgba(255,255,255,0.14)");
    frame.text(
      `coverage · target ${formatResolution(targetResolutionMs)}`,
      6,
      y + 4,
      "10px ui-monospace, monospace",
      "#cbd5e1",
      "left",
      "top",
    );
  }
}

function stateRank(state: ResolutionSegment["state"]): number {
  return state === "ready" || state === "empty" ? 0 : state === "pending" ? 1 : 2;
}

function resolutionHeight(resolutionMs: number): number {
  const minutes = Math.max(1, resolutionMs / 1_000 / 60);
  return Math.max(10, RESOLUTION_BAR_HEIGHT - Math.log2(minutes) * 2.2);
}

function formatResolution(ms: number): string {
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms >= 1_000 && ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${Math.round(ms)}ms`;
}
