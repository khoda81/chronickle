/**
 * Color ramp lookup table for the heatmap.
 *
 * The ramp is built once from a small set of gradient stops and cached at the
 * module level. It maps a normalized intensity in [0, 1] to an RGBA tuple.
 * Building it requires a canvas context (to evaluate the gradient), so it is
 * constructed lazily on first use.
 */

/** Ramp stops (cool -> warm). */
const RAMP_STOPS: readonly [number, string][] = [
  [0.0, "#0b1020"],
  [0.2, "#1b3a6b"],
  [0.4, "#2a8a6b"],
  [0.6, "#d4a017"],
  [0.8, "#e85d2f"],
  [1.0, "#ff2e4d"],
];

export const RAMP_RESOLUTION = 256;

let lut: Uint8ClampedArray | null = null;

/**
 * Return the 256-entry RGBA ramp (RAMP_RESOLUTION * 4 bytes).
 * Built once and cached. Throws if a 2D context cannot be obtained.
 */
export function rampLut(): Uint8ClampedArray {
  if (lut !== null) return lut;
  const buf = new Uint8ClampedArray(RAMP_RESOLUTION * 4);
  const canvas = document.createElement("canvas");
  canvas.width = RAMP_RESOLUTION;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("Unable to acquire 2D context for ramp LUT");
  }
  const grad = ctx.createLinearGradient(0, 0, RAMP_RESOLUTION, 0);
  for (const [stop, color] of RAMP_STOPS) {
    grad.addColorStop(stop, color);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, RAMP_RESOLUTION, 1);
  const data = ctx.getImageData(0, 0, RAMP_RESOLUTION, 1).data;
  buf.set(data);
  lut = buf;
  return buf;
}

/**
 * Map a normalized intensity in [0, 1] to a ramp index in
 * [0, RAMP_RESOLUTION - 1]. Values >= 1 clamp to the top.
 */
export function rampIndex(norm: number): number {
  const n = Math.min(1, Math.max(0, norm));
  return Math.min(
    RAMP_RESOLUTION - 1,
    Math.floor(n * (RAMP_RESOLUTION - 1)),
  );
}

/**
 * Format a ramp entry as an `rgb(...)` string. Avoids per-call allocation of
 * intermediate arrays.
 */
export function rampCss(buf: Uint8ClampedArray, idx: number): string {
  const o = idx * 4;
  const r = buf[o]!;
  const g = buf[o + 1]!;
  const b = buf[o + 2]!;
  return `rgb(${r}, ${g}, ${b})`;
}
