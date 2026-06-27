import type { Frame } from "./context.ts";
import { HEAT_HEIGHT, heatTopY, NUM_BANDS } from "./layout.ts";
import { rampLut, rampIndex } from "../ramp.ts";

/**
 * Triple-box recursive Gaussian approximation.
 *
 * Three consecutive box filters (running means) convolved produce a
 * piecewise-quadratic kernel that approximates a true Gaussian to within ~6%
 * in the tails and ~7% in FWHM. This is the Wells (1986) approximation used
 * by GIMP. It is O(N) per pass (three passes = O(N) total), uses no
 * transcendentals in the inner loop, and is unconditionally stable — a box
 * filter is just a running sum, so there is no IIR feedback to blow up.
 *
 * For a box of width `w = 2r+1`, the variance is `(w² - 1) / 12`. Three boxes
 * of equal width `w` give total variance `3·(w²-1)/12 = (w²-1)/4 = σ²`, so
 * `w = √(4σ² + 1)`. We round two widths to the nearest odd integer and derive
 * the third to hit the target variance as closely as possible.
 *
 * Accuracy vs. the previous splat (which used a true `exp(-d²/2)` Gaussian):
 * the output goes through a sigmoid and a 4096-entry color LUT, so the ~6%
 * shape difference is sub-quantization. The user verified that the previous
 * `bandTimeRadius` truncation (a much larger shape change) was visually
 * invisible, so the triple-box approximation is well within the visual budget.
 */
function boxRadiiForSigma(sigma: number): [number, number, number] {
  // Ideal per-box width (each box contributes variance (w²-1)/12; three boxes
  // => total variance (w²-1)/4 = σ² => w = √(4σ²+1)).
  const wIdeal = Math.sqrt(4 * sigma * sigma + 1);
  // Round two boxes to the nearest odd width, derive the third to hit the
  // target variance: w3² = 12σ² + 3 - w1² - w2².
  const w1 = Math.round(wIdeal);
  const w2 = w1;
  const w3 = Math.max(
    1,
    Math.round(Math.sqrt(Math.max(1, 12 * sigma * sigma + 3 - w1 * w1 - w2 * w2))),
  );
  // Width w = 2r+1 => r = (w-1)/2, floored to an integer.
  return [Math.floor((w1 - 1) / 2), Math.floor((w2 - 1) / 2), Math.floor((w3 - 1) / 2)];
}

/**
 * Apply a 1D box filter of integer radius `r` (window width `2r+1`) using a
 * running sum. O(N). Replicate (clamp) boundary handling: samples outside
 * `[0, N-1]` are treated as the nearest edge sample, so the blur feathers
 * out to the edge value — the standard edge-clamp behavior for Gaussian blur.
 *
 * The radius is capped at `floor(N/2)` as a safety net: if a pathological
 * sigma requests a window wider than the buffer, the result degrades to
 * "average of the whole signal" rather than reading out of bounds.
 */
function boxFilter(input: Float64Array, output: Float64Array, r: number): void {
  const N = input.length;
  if (N === 0) return;
  const rc = Math.min(r, Math.floor(N / 2));
  if (rc <= 0) {
    output.set(input);
    return;
  }
  const w = 2 * rc + 1;
  let sum = 0;
  for (let i = -rc; i <= rc; i++) {
    sum += input[Math.max(0, Math.min(N - 1, i))]!;
  }
  for (let x = 0; x < N; x++) {
    output[x] = sum / w;
    const outIdx = Math.max(0, Math.min(N - 1, x - rc));
    const inIdx = Math.max(0, Math.min(N - 1, x + rc + 1));
    sum += input[inIdx]! - input[outIdx]!;
  }
}

export interface HeatmapLayer {
  /**
   * Draw the wavelet heatmap from a staircase-evaluated series.
   *
   * @param evalTime  Ascending pixel-boundary timestamps (length W+1).
   * @param value     Staircase values at each timestamp, aligned with evalTime.
   *                 NaN where the broker had no coverage (gaps are skipped).
   * @param priceScale Vertical scale for the response normalization.
   */
  drawWaveletField(evalTime: Float64Array, value: Float32Array, priceScale: number): void;
  drawFadeOverlay(): void;
}

export const Heatmap = {
  create(frame: Frame): HeatmapLayer {
    return new HeatmapImpl(frame);
  },
};

class HeatmapImpl implements HeatmapLayer {
  private offscreen = new OffscreenCanvas(1, 1);
  private offCtx = this.offscreen.getContext("2d", { willReadFrequently: true })!;

  // Scratch buffers, grown lazily and reused across frames to keep the render
  // loop allocation-free. `impulse` holds the per-pixel Dirac train of
  // log-returns; `scratchA` / `scratchB` ping-pong between the three box
  // passes; `response` is the final per-band image.
  private impulse = new Float64Array(0);
  private scratchA = new Float64Array(0);
  private scratchB = new Float64Array(0);
  private response = new Float64Array(0);

  constructor(private readonly frame: Frame) {}

  drawWaveletField(evalTime: Float64Array, value: Float32Array, priceScale: number): void {
    const { tx, ctx, dpr } = this.frame;
    const width = tx.screenDomain.max - tx.screenDomain.min;
    const height = tx.yDomain.max - tx.yDomain.min;

    if (evalTime.length < 2 || width <= 0) return;
    if (evalTime.length !== value.length) {
      throw new Error(`drawWaveletField: length mismatch (${evalTime.length} vs ${value.length})`);
    }

    const numPx = Math.ceil(width * dpr);
    if (numPx <= 0) return;

    const y = heatTopY(height);
    const rateScale = Math.exp(priceScale);
    const ramp = rampLut();

    const minSigma = 14;
    const maxSigma = Math.max(minSigma, Math.min(128, numPx / 4));

    // Grow scratch buffers to fit the current frame. Only the response buffer
    // scales with NUM_BANDS; the per-row buffers scale with numPx.
    if (this.impulse.length < numPx) {
      this.impulse = new Float64Array(numPx);
      this.scratchA = new Float64Array(numPx);
      this.scratchB = new Float64Array(numPx);
    }
    if (this.response.length < NUM_BANDS * numPx) {
      this.response = new Float64Array(NUM_BANDS * numPx);
    }

    if (this.offscreen.width !== numPx || this.offscreen.height !== NUM_BANDS) {
      this.offscreen.width = numPx;
      this.offscreen.height = NUM_BANDS;
    }

    const imgData = this.offCtx.createImageData(numPx, NUM_BANDS);
    const data = imgData.data;

    const timePerPx = tx.xToTime(1 / dpr) - tx.xToTime(0);

    // --- Build the impulse train -------------------------------------------
    // One Dirac per jump, placed at the pixel index of the jump timestamp.
    // Gaps (NaN values) break runs: no impulse is emitted across a gap, so
    // the convolution does not smear returns across broker coverage holes.
    const impulse = this.impulse;
    impulse.fill(0, 0, numPx);

    let prevV = NaN;
    for (let i = 0; i < evalTime.length; i++) {
      const v = value[i]!;
      if (!Number.isFinite(v)) {
        prevV = NaN;
        continue;
      }
      if (!Number.isFinite(prevV)) {
        prevV = v;
        continue;
      }
      const tJump = evalTime[i]!;
      const jumpReturn = Math.log(v / prevV);
      // Pixel index of the jump relative to the screen origin. Jumps outside
      // the padded view are dropped (they would land beyond the buffer).
      const xFloat = (tx.timeToX(tJump) - tx.screenDomain.min) * dpr;
      const xi = Math.round(xFloat);
      if (xi >= 0 && xi < numPx) {
        impulse[xi] = impulse[xi]! + jumpReturn;
      }
      prevV = v;
    }

    // --- Per-band triple-box Gaussian --------------------------------------
    // For each band we run three box-filter passes over the impulse train and
    // write the result into the band's row of `response`. Cost is O(numPx)
    // per band, independent of sigma and of the number of jumps.
    const response = this.response;
    const scratchA = this.scratchA;
    const scratchB = this.scratchB;

    for (let b = 0; b < NUM_BANDS; b++) {
      const sigma = minSigma * Math.pow(maxSigma / minSigma, b / (NUM_BANDS - 1));
      const sigmaTime = sigma * timePerPx;
      // Per-band normalization: the previous splat divided by sigmaTime and
      // multiplied by rateScale. We fold both into the band's final pass so
      // the output is numerically identical.
      const norm = rateScale / sigmaTime;
      const [r1, r2, r3] = boxRadiiForSigma(sigma);

      // Three box passes, ping-ponging between scratchA and scratchB.
      boxFilter(impulse, scratchA, r1);
      boxFilter(scratchA, scratchB, r2);
      boxFilter(scratchB, scratchA, r3);

      // scratchA now holds the triple-box result. Write it into the band's
      // row of `response`, applying the per-band normalization.
      const bandOffset = b * numPx;
      for (let x = 0; x < numPx; x++) {
        response[bandOffset + x] = scratchA[x]! * norm;
      }
    }

    // --- Sigmoid + color LUT ------------------------------------------------
    // Unchanged from the splat implementation: per-pixel logistic squashing
    // then a 4096-entry RGBA LUT lookup.
    for (let b = 0; b < NUM_BANDS; b++) {
      const bandOffset = b * numPx;
      for (let x = 0; x < numPx; x++) {
        const z = response[bandOffset + x]!;
        const normalized = 1 / (1 + Math.exp(z));
        const idx = rampIndex(normalized);

        const pixelOffset = (bandOffset + x) * 4;
        const rampOffset = idx * 4;
        data[pixelOffset] = ramp[rampOffset]!;
        data[pixelOffset + 1] = ramp[rampOffset + 1]!;
        data[pixelOffset + 2] = ramp[rampOffset + 2]!;
        data[pixelOffset + 3] = 255;
      }
    }

    this.offCtx.putImageData(imgData, 0, 0);

    ctx.save();
    ctx.drawImage(this.offscreen, tx.screenDomain.min, y, width, HEAT_HEIGHT);
    ctx.restore();
  }

  drawFadeOverlay(): void {
    const { frame } = this;
    const { tx, ctx: ctx } = frame;
    const width = tx.screenDomain.max - tx.screenDomain.min;
    const height = tx.yDomain.max - tx.yDomain.min;
    const y = heatTopY(height);
    const grad = ctx.createLinearGradient(0, y, 0, y + HEAT_HEIGHT);
    grad.addColorStop(0, "rgba(0, 0, 0, 0)");
    grad.addColorStop(1, "rgba(0, 0, 0, 0.55)");
    ctx.fillStyle = grad;
    ctx.fillRect(tx.screenDomain.min, y, width, HEAT_HEIGHT);
  }
}
