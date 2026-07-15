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
 * Place the event tooltip like a card pulled from a horizontal deck.
 *
 * The horizontal `gap` is intentionally an overlap rather than empty spacing:
 * the event dot sits slightly inside the card's edge. The card prefers the
 * left/past side, remains vertically centered on the event dot, and is clamped
 * below the top strip reserved for the timeline's time-hover label.
 */
export function placeTooltip(input: TooltipPlacementInput): TooltipPosition {
  const anchorOverlap = input.gap ?? 9;
  const margin = input.margin ?? 8;

  const maxX = Math.max(margin, input.viewportWidth - margin - input.width);
  const maxY = Math.max(margin, input.viewportHeight - margin - input.height);

  // Deliberately overlap the event dot with the corresponding card edge.
  const leftX = input.anchorX - input.width + anchorOverlap;
  const rightX = input.anchorX - anchorOverlap;

  const leftFits = leftX >= margin;
  const rightFits = rightX + input.width <= input.viewportWidth - margin;
  const placement: TooltipPlacement = leftFits || !rightFits ? "left" : "right";

  const preferredX = placement === "left" ? leftX : rightX;
  const preferredY = input.anchorY - input.height / 2;

  return {
    x: clamp(preferredX, margin, maxX),

    // Keep the event card below the time-hover label at the top of the timeline.
    y: clamp(preferredY, 4 * margin + 15, maxY),

    placement,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
