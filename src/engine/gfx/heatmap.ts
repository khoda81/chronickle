import type { Interval } from "../../core/interval.ts";
import type { Frame } from "./context.ts";
import { RAMP_RESOLUTION, rampLut, rampIndex, type PaletteName } from "../ramp.ts";
import {
  computeWaveletField,
  signalEdgesToDeltas,
  usedSampleDensity,
  WaveletWorkspace,
  type WaveletMode,
  type WaveletWindow,
} from "../wavelet.ts";
import { SignalView } from "../../data/index.ts";

/**
 * Uniform time-cell grid passed to the transform.
 *
 * `evalTime` and `value` describe cell edges and their ZOH log prices. With M
 * cells there are M+1 edges. `padLeft`/`padRight` count off-screen cells, not
 * samples, which removes the previous W-vs-W+1 ambiguity.
 */
export interface PaddedEval {
  readonly evalTime: Float64Array;
  readonly view: SignalView;
  readonly padLeft: number;
  readonly padRight: number;
  readonly visibleCells: number;
}

export interface HeatmapLayer {
  drawWaveletField(
    padded: PaddedEval,
    priceScale: number,
    mode: WaveletMode,
    y: number,
    viewportHeight: number,
    scaleInterval: Interval,
    palette: PaletteName,
  ): Float64Array;
  drawFadeOverlay(y: number, heatHeight: number): void;
}

interface HeatmapResources {
  readonly offscreen: OffscreenCanvas;
  readonly offCtx: OffscreenCanvasRenderingContext2D;
  returns: Float64Array;
  density: Float64Array;
  scalesMs: Float64Array;
  imageData: ImageData | null;
  imagePixels: Uint32Array | null;
  lastRenderKey: string | null;
  readonly wavelet: WaveletWorkspace;
  readonly validWindow: { start: number; count: number };
}

// Adjacent rows are logarithmically close in scale and the Gaussian scale-space
// is smooth along that axis. Evaluate a compact set of anchor scales, then
// interpolate values before the sigmoid. The transform count also shrinks when
// a row is vertically compacted.
const MAX_TRANSFORM_BANDS = 32;
const EMPTY_DENSITY = new Float64Array(0);

const SIGMOID_MIN = -18;
const SIGMOID_MAX = 18;
const SIGMOID_LUT_SIZE = 1 << 17;
const SIGMOID_LUT: Uint16Array = new Uint16Array(SIGMOID_LUT_SIZE);
const packedRamps = new Map<PaletteName, Uint32Array>();
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 0x04;
const INVALID_PIXEL = packRgba(5, 7, 13, 255);

const span = SIGMOID_MAX - SIGMOID_MIN;
for (let i = 0; i < SIGMOID_LUT.length; i++) {
  const x = SIGMOID_MIN + (i * span) / (SIGMOID_LUT.length - 1);
  SIGMOID_LUT[i] = rampIndex(1 / (1 + Math.exp(x)));
}

// Frame/L2 wrappers are short-lived, but the expensive canvas and typed-array
// resources are persistent per rendering context.
const RESOURCE_BY_CONTEXT = new WeakMap<CanvasRenderingContext2D, Map<string, HeatmapResources>>();

export const Heatmap = {
  create: (frame: Frame, rowId: string) => new HeatmapImpl(frame, resourcesFor(frame.ctx, rowId)),
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
    scaleInterval: Interval,
    palette: PaletteName,
  ): Float64Array {
    const { tx, ctx } = this.frame;
    const width = tx.screenDomain.end - tx.screenDomain.start;
    // Time maximizes physical-pixel density; scale remains CSS-pixel geometry
    // and is enlarged by the frame's DPR transform with the rest of the UI.
    const bandCount = Math.max(2, Math.ceil(viewportHeight));
    const transformBandCount = Math.min(bandCount, MAX_TRANSFORM_BANDS);
    if (!(width > 0) || !(viewportHeight > 0)) return EMPTY_DENSITY;

    const { evalTime, view, padLeft, padRight, visibleCells } = padded;
    const { value, sampleTime } = view;
    if (evalTime.length !== value.length || value.length !== sampleTime.length) {
      throw new Error(
        `drawWaveletField: length mismatch (${evalTime.length}/${value.length}/${sampleTime.length})`,
      );
    }
    if (value.length < 2) return EMPTY_DENSITY;
    const cellCount = value.length - 1;
    if (
      !Number.isInteger(padLeft) ||
      !Number.isInteger(padRight) ||
      !Number.isInteger(visibleCells) ||
      padLeft < 0 ||
      padRight < 0 ||
      visibleCells < 1 ||
      padLeft + visibleCells + padRight !== cellCount
    ) {
      throw new Error(
        `drawWaveletField: cells=${cellCount}, visible=${visibleCells}, padding=${padLeft}+${padRight}`,
      );
    }
    if (!(scaleInterval.start > 0)) {
      throw new Error(
        `drawWaveletField: scale interval must start above zero, got ${scaleInterval.start}`,
      );
    }

    const stepMs = evalTime[1]! - evalTime[0]!;
    if (!(stepMs > 0)) throw new Error(`drawWaveletField: invalid grid step ${stepMs}`);

    const resources = this.resources;
    const renderKey = [
      padded.view.sampleRevision,
      evalTime[0],
      stepMs,
      visibleCells,
      padLeft,
      padRight,
      priceScale,
      mode,
      palette,
      bandCount,
      scaleInterval.start,
      scaleInterval.end,
    ].join("|");
    if (resources.lastRenderKey === renderKey) {
      drawField(ctx, resources.offscreen, tx.screenDomain.start, y, width, viewportHeight);
      return resources.density;
    }
    resources.returns = signalEdgesToDeltas(value, resources.returns);
    resources.density = usedSampleDensity(sampleTime, padLeft, visibleCells, resources.density);

    if (resources.scalesMs.length !== transformBandCount) {
      resources.scalesMs = new Float64Array(transformBandCount);
    }
    const scaleRatio = scaleInterval.end / scaleInterval.start;
    for (let band = 0; band < transformBandCount; band++) {
      const position = transformBandCount === 1 ? 0 : band / (transformBandCount - 1);
      resources.scalesMs[band] = scaleInterval.start * Math.pow(scaleRatio, position);
    }

    resources.validWindow.start = padLeft;
    resources.validWindow.count = visibleCells;
    const field = computeWaveletField(
      resources.returns,
      stepMs,
      resources.scalesMs,
      mode,
      undefined,
      resources.wavelet,
      mode === "centered" ? resources.validWindow : undefined,
    );
    ensureImage(resources, visibleCells, bandCount);
    const imagePixels = resources.imagePixels!;
    const ramp = packedRampLut(palette);
    const sigmoid = SIGMOID_LUT;
    const sigmoidScale = (SIGMOID_LUT_SIZE - 1) / (SIGMOID_MAX - SIGMOID_MIN);
    const sigmoidMidpoint = Math.floor((RAMP_RESOLUTION - 1) / 2);
    const gain = Math.exp(priceScale);
    const displayScaleRatio = (transformBandCount - 1) / (bandCount - 1);

    for (let band = 0; band < bandCount; band++) {
      const sourceBand = band * displayScaleRatio;
      const lowerBand = Math.floor(sourceBand);
      const upperBand = Math.min(transformBandCount - 1, lowerBand + 1);
      const mix = sourceBand - lowerBand;
      const lowerOffset = lowerBand * value.length + padLeft;
      const upperOffset = upperBand * value.length + padLeft;
      const pixelBandOffset = band * visibleCells;
      for (let x = 0; x < visibleCells; x++) {
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
    drawField(ctx, resources.offscreen, tx.screenDomain.start, y, width, viewportHeight);
    return resources.density;
  }

  drawFadeOverlay(y: number, heatHeight: number): void {
    const { tx, ctx } = this.frame;
    const width = tx.screenDomain.end - tx.screenDomain.start;
    const grad = ctx.createLinearGradient(0, y, 0, y + heatHeight);
    grad.addColorStop(0, "rgba(0, 0, 0, 0)");
    grad.addColorStop(1, "rgba(0, 0, 0, 0.55)");
    ctx.fillStyle = grad;
    ctx.fillRect(tx.screenDomain.start, y, width, heatHeight);
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
    density: new Float64Array(0),
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

function drawField(
  ctx: CanvasRenderingContext2D,
  image: OffscreenCanvas,
  x: number,
  y: number,
  width: number,
  viewportHeight: number,
): void {
  ctx.drawImage(image, x, y, width, viewportHeight);
}

function packRgba(red: number, green: number, blue: number, alpha: number): number {
  return LITTLE_ENDIAN
    ? (red | (green << 8) | (blue << 16) | (alpha << 24)) >>> 0
    : (alpha | (blue << 8) | (green << 16) | (red << 24)) >>> 0;
}
