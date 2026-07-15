/**
 * Pixel metrics shared by canvas placement code and DOM overlays.
 *
 * These values intentionally remain in CSS pixels: the renderer measures text,
 * draws connector lines, and positions DOM elements in the same coordinate
 * system. General application sizing belongs in CSS design tokens instead.
 */
export const TIMELINE_OVERLAY_METRICS = {
  rowInsetPx: 5,
  timeLabel: {
    marginPx: 5,
    gapPx: 9,
    topPx: 10,
  },
  signalTooltip: {
    font: "600 11px ui-monospace, monospace",
    paddingXPx: 7,
    borderWidthPx: 1,
    heightPx: 23,
    gapPx: 9,
    marginPx: 5,
  },
} as const;
