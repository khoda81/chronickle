import type { RssFeed } from "../domain.ts";
import type { HoverInfo } from "../engine/timeline.ts";

export type TooltipPlacement = "left" | "right";

export interface TooltipPosition {
  readonly x: number;
  readonly y: number;
  readonly placement: TooltipPlacement;
}

export interface TooltipPlacementInput {
  readonly anchorX: number;
  readonly anchorY: number;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly gap?: number;
  readonly margin?: number;
}

/**
 * Place a floating label beside an anchor while keeping its border inside the viewport.
 * The preferred position matches the old UI (above-right), then flips before clamping.
 */
export function placeTooltip(input: TooltipPlacementInput): TooltipPosition {
  const margin = input.margin ?? 8;

  const maxX = Math.max(margin, input.viewportWidth - margin - input.width);
  const maxY = Math.max(margin, input.viewportHeight - margin - input.height);

  const leftX = input.anchorX - input.width;
  const rightX = input.anchorX;

  const leftFits = leftX >= margin;
  const rightFits = rightX + input.width <= input.viewportWidth - margin;

  // Time flows leftward from the event, so left is always preferred.
  // Right is only used when left does not fit and right does.
  const placement: TooltipPlacement = leftFits || !rightFits ? "left" : "right";

  const preferredX = placement === "left" ? leftX : rightX;
  const preferredY = input.anchorY - input.height / 2;

  return {
    x: clamp(preferredX, margin, maxX),
    y: clamp(preferredY, 3 * margin + 15, maxY),
    placement,
  };
}


/** DOM owner for the event hover label. Content changes are rare; positioning is immediate. */
export class EventTooltip {
  private eventT = Number.NaN;
  private eventLink = "";
  private eventTitle = "";
  private eventSummary = "";
  private feedId = "";
  private feedSource = "";
  private feedColor = "";
  private measuredWidth = 0;
  private measuredHeight = 0;
  private measuredViewportWidth = Number.NaN;
  private measuredViewportHeight = Number.NaN;

  constructor(private readonly element: HTMLDivElement) { }

  show(event: HoverInfo, feed: RssFeed): void {
    const contentChanged =
      event.t !== this.eventT ||
      event.link !== this.eventLink ||
      event.title !== this.eventTitle ||
      event.summary !== this.eventSummary ||
      event.feedId !== this.feedId ||
      feed.source !== this.feedSource ||
      feed.color !== this.feedColor;

    if (contentChanged) {
      this.renderContent(event, feed);
      this.eventT = event.t;
      this.eventLink = event.link;
      this.eventTitle = event.title;
      this.eventSummary = event.summary;
      this.feedId = event.feedId;
      this.feedSource = feed.source;
      this.feedColor = feed.color;
      this.measuredWidth = 0;
      this.measuredHeight = 0;
    }

    if (
      this.measuredWidth === 0 ||
      this.measuredHeight === 0 ||
      event.viewportWidth !== this.measuredViewportWidth ||
      event.viewportHeight !== this.measuredViewportHeight
    ) {
      const rect = this.element.getBoundingClientRect();
      this.measuredWidth = rect.width;
      this.measuredHeight = rect.height;
      this.measuredViewportWidth = event.viewportWidth;
      this.measuredViewportHeight = event.viewportHeight;
    }

    const position = placeTooltip({
      anchorX: event.anchorX,
      anchorY: event.anchorY,
      width: this.measuredWidth,
      height: this.measuredHeight,
      viewportWidth: event.viewportWidth,
      viewportHeight: event.viewportHeight,
      gap: 4,
    });
    const wasHidden = this.element.classList.contains("hidden");
    this.element.dataset.placement = position.placement;
    this.element.style.setProperty("--tooltip-x", `${position.x}px`);
    this.element.style.setProperty("--tooltip-y", `${position.y}px`);
    if (wasHidden) void this.element.offsetWidth;
    this.element.classList.remove("hidden");
  }

  hide(): void {
    this.element.classList.add("hidden");
  }

  private renderContent(event: HoverInfo, feed: RssFeed): void {
    this.element.replaceChildren();
    this.element.style.setProperty("--outlet-color", feed.color);
    const source = document.createElement("span");
    source.className = "tooltip-source";
    source.textContent = `${feed.source} · ${new Date(event.t).toLocaleString()}`;

    const link = document.createElement("a");
    link.className = "tooltip-link";
    link.href = event.link;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = event.title;
    this.element.append(source, link);

    if (event.summary.length > 0) {
      const summary = document.createElement("p");
      summary.className = "tooltip-summary";
      summary.textContent = event.summary;
      this.element.append(summary);
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
