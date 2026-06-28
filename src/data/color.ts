/**
 * Stable, perceptually-uniform color generation for feed identities.
 *
 * We walk the hue circle by the golden angle (137.50776…°) in the oklch
 * color space, holding lightness and chroma fixed. This maximizes the
 * perceptual distance between successive feed colors and avoids the
 * clustering that a linear hue ramp produces.
 *
 * `oklch(...)` strings are accepted by Canvas `fillStyle` in all modern
 * browsers, so the renderer can use these directly without conversion.
 *
 * The `offset` is a fixed phase so the first feed doesn't always land on
 * the same hue — purely cosmetic.
 */

const GOLDEN_ANGLE = 137.50776405003785;
const L = 0.72;
const C = 0.16;

/**
 * Map a stable index to a color string. The same index always yields the
 * same color; indices are assigned once per feed at registration and never
 * renumbered (see `FeedRegistry`).
 */
export function idToColor(idx: number, offset = 56.234): string {
  const hue = (((idx * GOLDEN_ANGLE + offset) % 360) + 360) % 360;
  return `oklch(${L} ${C} ${hue})`;
}
