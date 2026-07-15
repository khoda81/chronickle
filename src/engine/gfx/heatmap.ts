import type { Frame } from "./context.ts";
import { HEATMAP_FIELD_HEIGHT, MIN_SIGMA, maxSigmaFor } from "./layout.ts";
import { RAMP_RESOLUTION, rampLut, rampIndex, type PaletteName } from "../ramp.ts";
import {
  computeWaveletField,
  logPriceEdgesToReturns,
  WaveletWorkspace,
  type WaveletMode,
  type WaveletWindow,
} from "../wavelet.ts";

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
    y: number,
    viewportHeight: number,
    verticalOffset: number,
    palette: PaletteName,
  ): void;
  drawFadeOverlay(y: number, heatHeight: number): void;
}

interface HeatmapResources {
  readonly offscreen: OffscreenCanvas;
  readonly offCtx: OffscreenCanvasRenderingContext2D;
  returns: Float64Array;
  scalesMs: Float64Array;
  imageData: ImageData | null;
  imagePixels: Uint32Array | null;
  lastRenderKey: string | null;
  readonly wavelet: WaveletWorkspace;
  readonly validWindow: { start: number; count: number };
}

// Adjacent rows are logarithmically close in scale and the Gaussian scale-space
// is smooth along that axis. Evaluate a compact set of anchor scales, then
// interpolate values before the sigmoid. At typical row heights this removes
// ~80% of inverse FFTs while retaining one displayed value per CSS row.
const MAX_TRANSFORM_BANDS = 32;

const SIGMOID_MIN = -18;
const SIGMOID_MAX = 18;
const SIGMOID_LUT_SIZE = 1 << 17;
let sigmoidLut: Uint16Array | null = null;
const packedRamps = new Map<PaletteName, Uint32Array>();
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 0x04;
const INVALID_PIXEL = packRgba(5, 7, 13, 255);

// Frame/L2 wrappers are short-lived, but the expensive canvas and typed-array
// resources are persistent per rendering context.
const RESOURCE_BY_CONTEXT = new WeakMap<CanvasRenderingContext2D, Map<string, HeatmapResources>>();

export const Heatmap = {
  create(frame: Frame, rowId: string): HeatmapLayer {
    return new HeatmapImpl(frame, resourcesFor(frame.ctx, rowId));
  },
};

class HeatmapImpl implements HeatmapLayer {
  constructor(
    private readonly frame: Frame,
    private readonly resources: HeatmapResources,
  ) { }

  drawWaveletField(
    padded: PaddedEval,
    priceScale: number,
    mode: WaveletMode,
    y: number,
    viewportHeight: number,
    verticalOffset: number,
    palette: PaletteName,
  ): void {
    const { tx, ctx, dpr } = this.frame;
    const width = tx.screenDomain.max - tx.screenDomain.min;
    const numPx = Math.ceil(width * dpr);
    // One independently evaluated scale per visible CSS row. Using device
    // rows would duplicate work on HiDPI screens without a perceptible gain;
    // Canvas performs the final DPR rasterization.
    const bandCount = HEATMAP_FIELD_HEIGHT;
    const transformBandCount = Math.min(bandCount, MAX_TRANSFORM_BANDS);
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
      palette,
      bandCount,
    ].join("|");
    if (resources.lastRenderKey === renderKey) {
      drawClippedField(
        ctx,
        resources.offscreen,
        tx.screenDomain.min,
        y,
        width,
        viewportHeight,
        verticalOffset,
      );
      return;
    }
    resources.returns = logPriceEdgesToReturns(value, resources.returns);

    if (resources.scalesMs.length !== transformBandCount) {
      resources.scalesMs = new Float64Array(transformBandCount);
    }
    const maxSigma = maxSigmaFor(numPx);
    for (let band = 0; band < transformBandCount; band++) {
      const sigmaPx = MIN_SIGMA * Math.pow(maxSigma / MIN_SIGMA, band / (transformBandCount - 1));
      resources.scalesMs[band] = sigmaPx * stepMs;
    }

    resources.validWindow.start = padLeft;
    resources.validWindow.count = numPx;
    const field = computeWaveletField(
      resources.returns,
      stepMs,
      resources.scalesMs,
      mode,
      undefined,
      resources.wavelet,
      mode === "centered" ? resources.validWindow : undefined,
    );
    ensureImage(resources, numPx, bandCount);
    const imagePixels = resources.imagePixels!;
    const ramp = packedRampLut(palette);
    const sigmoid = sigmoidIndexLut();
    const sigmoidScale = (SIGMOID_LUT_SIZE - 1) / (SIGMOID_MAX - SIGMOID_MIN);
    const sigmoidMidpoint = Math.floor((RAMP_RESOLUTION - 1) / 2);
    const gain = Math.exp(priceScale);
    const scaleRatio = (transformBandCount - 1) / (bandCount - 1);

    for (let band = 0; band < bandCount; band++) {
      const sourceBand = band * scaleRatio;
      const lowerBand = Math.floor(sourceBand);
      const upperBand = Math.min(transformBandCount - 1, lowerBand + 1);
      const mix = sourceBand - lowerBand;
      const lowerOffset = lowerBand * value.length + padLeft;
      const upperOffset = upperBand * value.length + padLeft;
      const pixelBandOffset = band * numPx;
      for (let x = 0; x < numPx; x++) {
        const lower = field.values[lowerOffset + x]!;
        const upper = field.values[upperOffset + x]!;
        const z = lower + (upper - lower) * mix;
        if (!Number.isFinite(z)) {
          imagePixels[pixelBandOffset + x] = INVALID_PIXEL;
          continue;
        }
        const amplified = z * gain;
        let rampOffset: number;
        if (Number.isNaN(amplified)) rampOffset = sigmoidMidpoint;
        else if (amplified === Number.NEGATIVE_INFINITY) rampOffset = RAMP_RESOLUTION - 1;
        else if (amplified >= SIGMOID_MAX) rampOffset = 0;
        else if (amplified <= SIGMOID_MIN) rampOffset = RAMP_RESOLUTION - 2;
        else {
          const position = (amplified - SIGMOID_MIN) * sigmoidScale;
          rampOffset = sigmoid[(position + 0.5) | 0]!;
        }
        imagePixels[pixelBandOffset + x] = ramp[rampOffset]!;
      }
    }

    resources.offCtx.putImageData(resources.imageData!, 0, 0);
    resources.lastRenderKey = renderKey;
    drawClippedField(
      ctx,
      resources.offscreen,
      tx.screenDomain.min,
      y,
      width,
      viewportHeight,
      verticalOffset,
    );
  }

  drawFadeOverlay(y: number, heatHeight: number): void {
    const { tx, ctx } = this.frame;
    const width = tx.screenDomain.max - tx.screenDomain.min;
    const grad = ctx.createLinearGradient(0, y, 0, y + heatHeight);
    grad.addColorStop(0, "rgba(0, 0, 0, 0)");
    grad.addColorStop(1, "rgba(0, 0, 0, 0.55)");
    ctx.fillStyle = grad;
    ctx.fillRect(tx.screenDomain.min, y, width, heatHeight);
  }
}

function resourcesFor(ctx: CanvasRenderingContext2D, rowId: string): HeatmapResources {
  let byRow = RESOURCE_BY_CONTEXT.get(ctx);
  if (byRow === undefined) {
    byRow = new Map();
    RESOURCE_BY_CONTEXT.set(ctx, byRow);
  }
  let resources = byRow.get(rowId);
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
    imagePixels: null,
    lastRenderKey: null,
    wavelet: new WaveletWorkspace(),
    validWindow: { start: 0, count: 0 } satisfies WaveletWindow,
  };
  byRow.set(rowId, resources);
  return resources;
}

function ensureImage(resources: HeatmapResources, width: number, bandCount: number): void {
  if (resources.offscreen.width !== width || resources.offscreen.height !== bandCount) {
    resources.offscreen.width = width;
    resources.offscreen.height = bandCount;
    resources.imageData = null;
    resources.imagePixels = null;
    resources.lastRenderKey = null;
  }
  if (resources.imageData === null) {
    resources.imageData = resources.offCtx.createImageData(width, bandCount);
    const data = resources.imageData.data;
    resources.imagePixels = new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4);
  }
}

function sigmoidIndexLut(): Uint16Array {
  let lut = sigmoidLut;
  if (lut !== null) return lut;
  lut = new Uint16Array(SIGMOID_LUT_SIZE);
  const span = SIGMOID_MAX - SIGMOID_MIN;
  for (let i = 0; i < lut.length; i++) {
    const x = SIGMOID_MIN + (i / (lut.length - 1)) * span;
    lut[i] = rampIndex(1 / (1 + Math.exp(x)));
  }
  sigmoidLut = lut;
  return lut;
}

function packedRampLut(name: PaletteName): Uint32Array {
  const cached = packedRamps.get(name);
  if (cached !== undefined) return cached;
  const rgba = rampLut(name);
  const result = new Uint32Array(RAMP_RESOLUTION);
  for (let index = 0; index < result.length; index++) {
    const offset = index * 4;
    result[index] = packRgba(rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!, 255);
  }
  packedRamps.set(name, result);
  return result;
}

function drawClippedField(
  ctx: CanvasRenderingContext2D,
  image: OffscreenCanvas,
  x: number,
  y: number,
  width: number,
  viewportHeight: number,
  verticalOffset: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, viewportHeight);
  ctx.clip();
  ctx.drawImage(image, x, y + verticalOffset, width, HEATMAP_FIELD_HEIGHT);
  ctx.restore();
}

function packRgba(red: number, green: number, blue: number, alpha: number): number {
  return LITTLE_ENDIAN
    ? (red | (green << 8) | (blue << 16) | (alpha << 24)) >>> 0
    : (alpha | (blue << 8) | (green << 16) | (red << 24)) >>> 0;
}
