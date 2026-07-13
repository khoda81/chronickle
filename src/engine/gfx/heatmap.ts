import type { Frame } from "./context.ts";
import { heatTopY, MIN_SIGMA, maxSigmaFor } from "./layout.ts";
import { rampLut, rampIndex, rampPaletteName } from "../ramp.ts";
import { computeWaveletField, logPriceEdgesToReturns, type WaveletMode } from "../wavelet.ts";

/**
 * Uniform time-cell grid passed to the transform.
 *
 * `evalTime` and `value` describe cell edges and their ZOH log prices. With M
 * cells there are M+1 edges. `padLeft`/`padRight` count off-screen cells, not
 * samples, which removes the previous W-vs-W+1 ambiguity.
 */
export interface PaddedEval {
  readonly evalTime: Float64Array;
  readonly value: Float64Array;
  readonly padLeft: number;
  readonly padRight: number;
  /** Broker cache revision, used to avoid recomputation on hover-only draws. */
  readonly revision: number;
}

export interface HeatmapLayer {
  drawWaveletField(
    padded: PaddedEval,
    priceScale: number,
    mode: WaveletMode,
    heatHeight: number,
  ): void;
  drawFadeOverlay(heatHeight: number): void;
}

interface HeatmapResources {
  readonly offscreen: OffscreenCanvas;
  readonly offCtx: OffscreenCanvasRenderingContext2D;
  returns: Float64Array;
  scalesMs: Float64Array;
  imageData: ImageData | null;
  lastRenderKey: string | null;
}

// Frame/L2 wrappers are short-lived, but the expensive canvas and typed-array
// resources are persistent per rendering context.
const RESOURCE_BY_CONTEXT = new WeakMap<CanvasRenderingContext2D, HeatmapResources>();

export const Heatmap = {
  create(frame: Frame): HeatmapLayer {
    return new HeatmapImpl(frame, resourcesFor(frame.ctx));
  },
};

class HeatmapImpl implements HeatmapLayer {
  constructor(
    private readonly frame: Frame,
    private readonly resources: HeatmapResources,
  ) {}

  drawWaveletField(
    padded: PaddedEval,
    priceScale: number,
    mode: WaveletMode,
    heatHeight: number,
  ): void {
    const { tx, ctx, dpr } = this.frame;
    const width = tx.screenDomain.max - tx.screenDomain.min;
    const height = tx.yDomain.max - tx.yDomain.min;
    const numPx = Math.ceil(width * dpr);
    // One independently evaluated scale per visible CSS row. Using device
    // rows would duplicate work on HiDPI screens without a perceptible gain;
    // Canvas performs the final DPR rasterization.
    const bandCount = Math.max(2, Math.ceil(heatHeight));
    if (numPx <= 0) return;

    const { evalTime, value, padLeft, padRight } = padded;
    if (evalTime.length !== value.length) {
      throw new Error(`drawWaveletField: length mismatch (${evalTime.length} vs ${value.length})`);
    }
    if (value.length < 2) return;
    const cellCount = value.length - 1;
    if (
      !Number.isInteger(padLeft) ||
      !Number.isInteger(padRight) ||
      padLeft < 0 ||
      padRight < 0 ||
      padLeft + numPx + padRight !== cellCount
    ) {
      throw new Error(
        `drawWaveletField: cells=${cellCount}, visible=${numPx}, padding=${padLeft}+${padRight}`,
      );
    }

    const stepMs = evalTime[1]! - evalTime[0]!;
    if (!(stepMs > 0)) throw new Error(`drawWaveletField: invalid grid step ${stepMs}`);

    const resources = this.resources;
    const renderKey = [
      padded.revision,
      evalTime[0],
      stepMs,
      numPx,
      padLeft,
      padRight,
      priceScale,
      mode,
      rampPaletteName(),
      bandCount,
    ].join("|");
    if (resources.lastRenderKey === renderKey) {
      ctx.drawImage(
        resources.offscreen,
        tx.screenDomain.min,
        heatTopY(height, heatHeight),
        width,
        heatHeight,
      );
      return;
    }
    resources.returns = logPriceEdgesToReturns(value, resources.returns);

    if (resources.scalesMs.length !== bandCount) resources.scalesMs = new Float64Array(bandCount);
    const maxSigma = maxSigmaFor(numPx);
    for (let band = 0; band < bandCount; band++) {
      const sigmaPx = MIN_SIGMA * Math.pow(maxSigma / MIN_SIGMA, band / (bandCount - 1));
      resources.scalesMs[band] = sigmaPx * stepMs;
    }

    const field = computeWaveletField(resources.returns, stepMs, resources.scalesMs, mode);
    ensureImage(resources, numPx, bandCount);
    const image = resources.imageData!;
    const pixels = image.data;
    const ramp = rampLut();
    const gain = Math.exp(priceScale);

    for (let band = 0; band < bandCount; band++) {
      const fieldOffset = band * value.length + padLeft;
      const pixelBandOffset = band * numPx;
      for (let x = 0; x < numPx; x++) {
        const z = field.values[fieldOffset + x]!;
        const pixelOffset = (pixelBandOffset + x) * 4;
        if (!Number.isFinite(z)) {
          pixels[pixelOffset] = 5;
          pixels[pixelOffset + 1] = 7;
          pixels[pixelOffset + 2] = 13;
          pixels[pixelOffset + 3] = 255;
          continue;
        }
        const normalized = 1 / (1 + Math.exp(z * gain));
        const rampOffset = rampIndex(normalized) * 4;
        pixels[pixelOffset] = ramp[rampOffset]!;
        pixels[pixelOffset + 1] = ramp[rampOffset + 1]!;
        pixels[pixelOffset + 2] = ramp[rampOffset + 2]!;
        pixels[pixelOffset + 3] = 255;
      }
    }

    resources.offCtx.putImageData(image, 0, 0);
    resources.lastRenderKey = renderKey;
    ctx.drawImage(
      resources.offscreen,
      tx.screenDomain.min,
      heatTopY(height, heatHeight),
      width,
      heatHeight,
    );
  }

  drawFadeOverlay(heatHeight: number): void {
    const { tx, ctx } = this.frame;
    const width = tx.screenDomain.max - tx.screenDomain.min;
    const height = tx.yDomain.max - tx.yDomain.min;
    const y = heatTopY(height, heatHeight);
    const grad = ctx.createLinearGradient(0, y, 0, y + heatHeight);
    grad.addColorStop(0, "rgba(0, 0, 0, 0)");
    grad.addColorStop(1, "rgba(0, 0, 0, 0.55)");
    ctx.fillStyle = grad;
    ctx.fillRect(tx.screenDomain.min, y, width, heatHeight);
  }
}

function resourcesFor(ctx: CanvasRenderingContext2D): HeatmapResources {
  let resources = RESOURCE_BY_CONTEXT.get(ctx);
  if (resources !== undefined) return resources;
  const offscreen = new OffscreenCanvas(1, 1);
  const offCtx = offscreen.getContext("2d", { willReadFrequently: true });
  if (offCtx === null) throw new Error("Offscreen 2D context unavailable");
  resources = {
    offscreen,
    offCtx,
    returns: new Float64Array(0),
    scalesMs: new Float64Array(0),
    imageData: null,
    lastRenderKey: null,
  };
  RESOURCE_BY_CONTEXT.set(ctx, resources);
  return resources;
}

function ensureImage(resources: HeatmapResources, width: number, bandCount: number): void {
  if (resources.offscreen.width !== width || resources.offscreen.height !== bandCount) {
    resources.offscreen.width = width;
    resources.offscreen.height = bandCount;
    resources.imageData = null;
    resources.lastRenderKey = null;
  }
  if (resources.imageData === null) {
    resources.imageData = resources.offCtx.createImageData(width, bandCount);
  }
}
