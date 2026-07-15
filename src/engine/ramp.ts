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
 * Palette stops are defined in OKLCH for intuitive color design. At build time
 * each stop is converted to **linear sRGB** via the standard OKLab matrix;
 * LUT entries are produced by piecewise-linear blending in linear-light RGB,
 * then gamma-encoded to display sRGB. No canvas or browser color APIs are used.
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
 *
 * Keyed by name so an unknown palette is unrepresentable at the type level:
 * `setRampPalette` takes `keyof typeof PALETTES` rather than `string`, and the
 * lookup is O(1) with no throw branch.
 */
export const PALETTES = {
  "blue-orange": {
    name: "blue-orange",
    stops: [
      [0.0, 0.7, 0.16, 250],
      [0.5, 0.22, 0.0, 250],
      [1.0, 0.7, 0.16, 30],
    ],
  },
  "teal-red": {
    name: "teal-red",
    stops: [
      [0.0, 0.68, 0.14, 195],
      [0.5, 0.22, 0.0, 195],
      [1.0, 0.68, 0.17, 28],
    ],
  },
  "purple-green": {
    name: "purple-green",
    stops: [
      [0.0, 0.62, 0.18, 300],
      [0.5, 0.22, 0.0, 300],
      [1.0, 0.62, 0.16, 130],
    ],
  },
  "magenta-cyan": {
    name: "magenta-cyan",
    stops: [
      [0.0, 0.7, 0.2, 355],
      [0.5, 0.24, 0.0, 355],
      [1.0, 0.7, 0.15, 175],
    ],
  },
  "red-green": {
    name: "red-green",
    stops: [
      [0.0, 0.62, 0.19, 25],
      [0.5, 0.24, 0.0, 25],
      [1.0, 0.62, 0.17, 145],
    ],
  },
} as const satisfies Record<string, RampPalette>;

/** Valid palette names. */
export type PaletteName = keyof typeof PALETTES;

export const DEFAULT_PALETTE: PaletteName = "blue-orange";

export const RAMP_RESOLUTION = 4096;

const lutByPalette = new Map<PaletteName, Uint8ClampedArray>();

/**
 * Return the 256-entry RGBA ramp (RAMP_RESOLUTION * 4 bytes). Stops are
 * converted from OKLCH to linear sRGB, interpolated in linear-light RGB, then
 * gamma-encoded to display sRGB. Built once per palette and cached.
 *
 * @throws if stops are malformed.
 */
export function rampLut(name: PaletteName): Uint8ClampedArray {
  const cached = lutByPalette.get(name);
  if (cached !== undefined) return cached;
  const lut = buildLut(PALETTES[name]);
  lutByPalette.set(name, lut);
  return lut;
}

/** CSS preview of the same perceptual stops used by a heatmap row. */
export function paletteCssGradient(name: PaletteName): string {
  return `linear-gradient(90deg, ${PALETTES[name].stops
    .map(
      ([position, lightness, chroma, hue]) =>
        `oklch(${lightness * 100}% ${chroma} ${hue}) ${position * 100}%`,
    )
    .join(", ")})`;
}

/**
 * OKLCH → linear sRGB via the standard OKLab matrix.
 * May return out-of-gamut components (< 0 or > 1); clamping is deferred to
 * `linearToSrgb` so interpolation stays correct across the gamut boundary.
 */
function oklchToLinearRgb(L: number, C: number, H: number): readonly [number, number, number] {
  const hr = (H * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  // OKLab → LMS (cube-root compressed cone activations)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/**
 * Linear-light sRGB → display-encoded sRGB (IEC 61966-2-1).
 * Clamps out-of-gamut inputs to [0, 1] before encoding.
 */
function linearToSrgb(x: number): number {
  const c = x < 0 ? 0 : x > 1 ? 1 : x;
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function buildLut(palette: RampPalette): Uint8ClampedArray {
  validateStops(palette);

  // Pre-convert every OKLCH stop to linear sRGB so interpolation is a plain lerp.
  const linStops: Array<readonly [number, number, number, number]> = palette.stops.map(
    ([pos, L, C, H]) => {
      const [r, g, b] = oklchToLinearRgb(L, C, H);
      return [pos, r, g, b] as const;
    },
  );

  const buf = new Uint8ClampedArray(RAMP_RESOLUTION * 4);
  for (let i = 0; i < RAMP_RESOLUTION; i++) {
    const t = i / (RAMP_RESOLUTION - 1);
    const [r, g, b] = sampleLinearRgb(linStops, t);
    buf[i * 4 + 0] = Math.round(linearToSrgb(r) * 255);
    buf[i * 4 + 1] = Math.round(linearToSrgb(g) * 255);
    buf[i * 4 + 2] = Math.round(linearToSrgb(b) * 255);
    buf[i * 4 + 3] = 255;
  }
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
 * Piecewise-linear interpolation in linear sRGB. Each entry in `stops` is
 * `[position, r_linear, g_linear, b_linear]`; the three channel components
 * are blended independently with no hue-arc correction.
 */
function sampleLinearRgb(
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
  return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
}

/**
 * Map a normalized intensity in [0, 1] to a ramp index in
 * [0, RAMP_RESOLUTION - 1]. Values outside [0, 1] clamp to the ends.
 */
export function rampIndex(norm: number): number {
  const n = Math.min(1, Math.max(0, norm));
  return Math.min(RAMP_RESOLUTION - 1, Math.floor(n * (RAMP_RESOLUTION - 1)));
}
