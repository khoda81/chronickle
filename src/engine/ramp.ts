/**
 * Diverging color ramp for the heatmap.
 *
 * The ramp is **symmetric**: it encodes a signed rate in [-maxRate, +maxRate]
 * mapped to [0, 1], where 0.5 (rate == 0) is a neutral midpoint and the two
 * ends are perceptual opposites. Mixing position p with position (1-p) yields
 * the midpoint: hues are complementary (180° apart), lightness and chroma are
 * mirrored about the center, and the midpoint has chroma 0 so the hue
 * discontinuity there is invisible. Neither pole is "bad" or "good".
 *
 * Interpolation happens in the **OKLCH** perceptual color space (linear in L,
 * C, and hue-along-shorter-arc), which gives visually uniform steps. The
 * browser performs OKLCH → sRGB conversion per LUT entry by drawing a 1px
 * rect with an `oklch()` fill and reading back the RGBA — no manual
 * color-space matrix, and it tracks the user's display gamut automatically.
 */

/**
 * A diverging palette: a name plus OKLCH stops `[position, L, C, H]`.
 *
 *  - L (lightness): 0..1.
 *  - C (chroma):    0..~0.37. Zero at the neutral midpoint so the hue
 *                   discontinuity there is invisible.
 *  - H (hue):       0..360 degrees. The two ends should be ~180° apart
 *                   (complementary) so they perceptually cancel at the center.
 *
 * Stops must be sorted ascending by position with the first at 0 and the
 * last at 1; this is verified at build time.
 */
export interface RampPalette {
  readonly name: string;
  readonly stops: readonly (readonly [number, number, number, number])[];
}

/**
 * Built-in palettes. All are symmetric diverging: complementary hues at the
 * poles, mirrored L/C, chroma 0 at the midpoint.
 *
 *  - "blue-orange": classic cool/warm. Blue (~250°) vs orange (~30°+180°=210°
 *    is blue, so orange is ~30°). Calm, the workhorse default.
 *  - "teal-red":    Teal (~190°) vs red (~10°). High contrast, colorblind-safe.
 *  - "purple-green": Purple (~300°) vs green (~120°). Colorblind-safe pair.
 *  - "magenta-cyan": Magenta (~350°) vs cyan (~170°). Vivid, high saturation.
 *  - "red-green":   Red (~25°) vs green (~145°). Familiar but **not**
 *                   colorblind-safe; included for comparison only.
 */
export const PALETTES: readonly RampPalette[] = [
  {
    name: "blue-orange",
    stops: [
      [0.0, 0.7, 0.16, 250],
      [0.5, 0.22, 0.0, 250],
      [1.0, 0.7, 0.16, 30],
    ],
  },
  {
    name: "teal-red",
    stops: [
      [0.0, 0.68, 0.14, 195],
      [0.5, 0.22, 0.0, 195],
      [1.0, 0.68, 0.17, 28],
    ],
  },
  {
    name: "purple-green",
    stops: [
      [0.0, 0.62, 0.18, 300],
      [0.5, 0.22, 0.0, 300],
      [1.0, 0.62, 0.16, 130],
    ],
  },
  {
    name: "magenta-cyan",
    stops: [
      [0.0, 0.7, 0.2, 355],
      [0.5, 0.24, 0.0, 355],
      [1.0, 0.7, 0.15, 175],
    ],
  },
  {
    name: "red-green",
    stops: [
      [0.0, 0.62, 0.19, 25],
      [0.5, 0.24, 0.0, 25],
      [1.0, 0.62, 0.17, 145],
    ],
  },
] as const;

export const RAMP_RESOLUTION = 256;

let activePalette: RampPalette = PALETTES[0]!;
let lut: Uint8ClampedArray | null = null;

/**
 * Switch the active palette by name. Invalidates the cached LUT so the next
 * `rampLut()` rebuilds it. Throws if the name is unknown.
 */
export function setRampPalette(name: string): void {
  const p = PALETTES.find((p) => p.name === name);
  if (p === undefined) {
    throw new Error(`Unknown ramp palette: ${name}`);
  }
  if (p === activePalette) return;
  activePalette = p;
  lut = null;
}

/** Current palette name. */
export function rampPaletteName(): string {
  return activePalette.name;
}

/**
 * Return the 256-entry RGBA ramp (RAMP_RESOLUTION * 4 bytes), interpolated
 * in OKLCH and converted to sRGB by the browser. Built once per palette and
 * cached.
 *
 * @throws if stops are malformed or a 2D context cannot be obtained.
 */
export function rampLut(): Uint8ClampedArray {
  if (lut !== null) return lut;
  lut = buildLut(activePalette);
  return lut;
}

function buildLut(palette: RampPalette): Uint8ClampedArray {
  validateStops(palette);

  const buf = new Uint8ClampedArray(RAMP_RESOLUTION * 4);
  const canvas = document.createElement("canvas");
  canvas.width = RAMP_RESOLUTION;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("Unable to acquire 2D context for ramp LUT");
  }

  const stops = palette.stops;
  for (let i = 0; i < RAMP_RESOLUTION; i++) {
    const t = i / (RAMP_RESOLUTION - 1);
    const [l, c, h] = sampleStops(stops, t);
    // Let the browser convert OKLCH → sRGB in display gamut.
    ctx.fillStyle = `oklch(${l} ${c} ${h})`;
    ctx.fillRect(i, 0, 1, 1);
  }

  const data = ctx.getImageData(0, 0, RAMP_RESOLUTION, 1).data;
  buf.set(data);
  return buf;
}

function validateStops(palette: RampPalette): void {
  const stops = palette.stops;
  if (stops.length < 2) {
    throw new Error(`Palette "${palette.name}" must have >= 2 stops`);
  }
  const first = stops[0]![0];
  const last = stops[stops.length - 1]![0];
  if (first !== 0 || last !== 1) {
    throw new Error(`Palette "${palette.name}" must span [0, 1]; got [${first}, ${last}]`);
  }
  for (let i = 1; i < stops.length; i++) {
    const prev = stops[i - 1]![0];
    const curr = stops[i]![0];
    if (!(curr > prev)) {
      throw new Error(`Palette "${palette.name}" must be strictly ascending at index ${i}`);
    }
  }
}

/**
 * Piecewise-linear interpolation in OKLCH. Hue is interpolated along the
 * shorter arc between adjacent stops; since the neutral midpoint has C=0,
 * any hue discontinuity there is imperceptible.
 */
function sampleStops(
  stops: readonly (readonly [number, number, number, number])[],
  t: number,
): readonly [number, number, number] {
  const first = stops[0]!;
  if (t <= first[0]) return [first[1], first[2], first[3]];
  const last = stops[stops.length - 1]!;
  if (t >= last[0]) return [last[1], last[2], last[3]];

  let i = 0;
  while (i + 1 < stops.length && stops[i + 1]![0] < t) i++;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  const f = (t - a[0]) / (b[0] - a[0]);
  const l = a[1] + (b[1] - a[1]) * f;
  const c = a[2] + (b[2] - a[2]) * f;
  const h = lerpHue(a[3], b[3], f);
  return [l, c, h];
}

/** Interpolate hue along the shorter arc, result in [0, 360). */
function lerpHue(h0: number, h1: number, f: number): number {
  let d = h1 - h0;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  let h = h0 + d * f;
  if (h < 0) h += 360;
  else if (h >= 360) h -= 360;
  return h;
}

/**
 * Map a normalized intensity in [0, 1] to a ramp index in
 * [0, RAMP_RESOLUTION - 1]. Values outside [0, 1] clamp to the ends.
 */
export function rampIndex(norm: number): number {
  const n = Math.min(1, Math.max(0, norm));
  return Math.min(RAMP_RESOLUTION - 1, Math.floor(n * (RAMP_RESOLUTION - 1)));
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
