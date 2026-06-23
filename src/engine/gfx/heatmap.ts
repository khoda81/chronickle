import type { PricePoint, PriceSeries } from "../../domain.ts";
import type { Frame } from "./context.ts";
import { HEAT_HEIGHT, heatTopY, NUM_BANDS } from "./layout.ts";
import { rampLut, rampIndex } from "../ramp.ts";

/**
 * Generates a 1D Standard Gaussian kernel (Gauss0).
 * Replaces Gauss1 because we are convolving with Dirac deltas (returns) instead of steps (prices).
 */
function createGaus0Kernel(sigma: number): Float32Array {
  const radius = Math.ceil(4 * sigma);
  const size = radius * 2 + 1;
  const kernel = new Float32Array(size);

  // Normalization factor to keep energy consistent across scales
  const norm = 1 / (sigma * Math.sqrt(2 * Math.PI));
  const scale = 2 * sigma * sigma;

  for (let i = 0; i < size; i++) {
    const t = i - radius;
    kernel[i] = norm * Math.exp(-(t * t) / scale);
  }

  return kernel;
}

export interface HeatmapLayer {
  drawBoxStack(series: PriceSeries, priceScale: number): void;
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

  // Cache buffers to avoid GC pressure
  private jumpTimes = new Float32Array(0);
  private jumpReturns = new Float32Array(0);

  constructor(private readonly frame: Frame) {}

  private updateJumpsBuffer(obs: readonly PricePoint[]) {
    const requiredLen = obs.length;
    if (this.jumpTimes.length < requiredLen) {
      // Allocate slightly more to prevent frequent reallocations
      const newCap = Math.ceil(requiredLen * 1.2);
      this.jumpTimes = new Float32Array(newCap);
      this.jumpReturns = new Float32Array(newCap);
    }

    // First observation has no return
    this.jumpTimes[0] = obs[0].t;
    this.jumpReturns[0] = 0;

    for (let i = 1; i < requiredLen; i++) {
      this.jumpTimes[i] = obs[i].t;
      // ZOH Dirac delta magnitude: log(P_i) - log(P_{i-1})
      this.jumpReturns[i] = Math.log(obs[i].price) - Math.log(obs[i - 1].price);
    }
    return requiredLen;
  }

  drawBoxStack(series: PriceSeries, priceScale: number): void {
    const { tx, ctx, dpr } = this.frame;
    const width = tx.screenDomain.max - tx.screenDomain.min;
    const height = tx.yDomain.max - tx.yDomain.min;
    const obs = series.observations;

    if (obs.length < 2 || width <= 0) return;

    const numPx = Math.ceil(width * dpr);
    if (numPx <= 0) return;

    // Build the sparse event arrays (cache-friendly SoA layout)
    const numJumps = this.updateJumpsBuffer(obs);

    const y = heatTopY(height);
    const rateScale = -Math.exp(priceScale);
    const ramp = rampLut();

    const minSigma = 14;
    const maxSigma = Math.max(minSigma, Math.min(128, numPx / 4));

    if (this.offscreen.width !== numPx || this.offscreen.height !== NUM_BANDS) {
      this.offscreen.width = numPx;
      this.offscreen.height = NUM_BANDS;
    }

    const imgData = this.offCtx.createImageData(numPx, NUM_BANDS);
    const data = imgData.data;

    // Conversion factor to map spatial kernel radius back to time
    const timePerPx = tx.xToTime(1 / dpr) - tx.xToTime(0);

    // --- SLIDING WINDOW CONVOLUTION ---
    // Instead of looping over a fixed radius of pixels, we find the index range
    // of active jumps for the current pixel's time.
    let windowStartIdx = 0;

    for (let x = 0; x < numPx; x++) {
      const t_pixel = tx.xToTime(x / dpr);

      // We only care about jumps within the maximum possible kernel radius
      const maxTimeRadius = 4 * maxSigma * timePerPx;
      const windowMinTime = t_pixel - maxTimeRadius;

      // Advance the start of our window
      while (windowStartIdx < numJumps && this.jumpTimes[windowStartIdx]! < windowMinTime) {
        windowStartIdx++;
      }

      for (let b = 0; b < NUM_BANDS; b++) {
        // const kernel = kernels[b];
        const sigma = minSigma * Math.pow(maxSigma / minSigma, b / (NUM_BANDS - 1));
        const bandTimeRadius = 3 * sigma * timePerPx;

        // Precompute these outside the pixel loop for each band
        const sigmaTime = sigma * timePerPx;
        const invTwoSigmaSq = 1 / (2 * sigmaTime * sigmaTime);

        let response = 0;
        for (let i = windowStartIdx; i < numJumps; i++) {
          const t_jump = this.jumpTimes[i]!;
          const deltaT = t_jump - t_pixel;
          if (deltaT > bandTimeRadius) break; // Out of radius, stop scanning

          if (deltaT >= -bandTimeRadius) {
            // Evaluate the exact continuous Gaussian at the sub-pixel distance
            const weight = Math.exp(-(deltaT * deltaT) * invTwoSigmaSq);

            // Add the Dirac delta's contribution
            response += this.jumpReturns[i]! * weight;
          }
        }

        const deltaTEquiv = sigma * timePerPx;
        const power = rateScale / deltaTEquiv;

        const z = response * power;
        const normalized = 1 / (1 + Math.exp(z));
        const idx = rampIndex(normalized);

        const pixelOffset = (b * numPx + x) * 4;
        const rampOffset = idx * 4;

        data[pixelOffset] = ramp[rampOffset];
        data[pixelOffset + 1] = ramp[rampOffset + 1];
        data[pixelOffset + 2] = ramp[rampOffset + 2];
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
