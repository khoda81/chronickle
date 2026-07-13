/** Multi-scale transforms of the binned log-return measure. */

import { fft, nextPowerOfTwo } from "./fft.ts";

export type WaveletMode = "centered" | "causal";

export interface WaveletOptions {
  /** Symmetric Gaussian truncation radius in standard deviations. */
  readonly gaussianCutoff: number;
  /** Number of first-order filters in the causal Erlang cascade. */
  readonly causalStages: number;
  /** Warm-up/context in multiples of the cascade's mean delay. */
  readonly causalWarmup: number;
}

export const DEFAULT_WAVELET_OPTIONS: WaveletOptions = {
  gaussianCutoff: 5,
  causalStages: 4,
  causalWarmup: 4,
};

export interface WaveletField {
  /** Band-major values: `values[band * sampleCount + sample]`. */
  readonly values: Float64Array;
  readonly bandCount: number;
  readonly sampleCount: number;
}

export interface KernelContext {
  readonly leftCells: number;
  readonly rightCells: number;
}

/** Context required for the largest scale, expressed in input cells. */
export function kernelContext(
  mode: WaveletMode,
  maxSigmaCells: number,
  options: Partial<WaveletOptions> = {},
): KernelContext {
  const opts = { ...DEFAULT_WAVELET_OPTIONS, ...options };
  validateOptions(opts);
  if (!(maxSigmaCells > 0) || !Number.isFinite(maxSigmaCells)) {
    throw new Error(`kernelContext: invalid sigma ${maxSigmaCells}`);
  }
  if (mode === "centered") {
    const cells = Math.ceil(opts.gaussianCutoff * maxSigmaCells);
    return { leftCells: cells, rightCells: cells };
  }
  const meanDelayCells = Math.sqrt(opts.causalStages) * maxSigmaCells;
  return {
    leftCells: Math.ceil(opts.causalWarmup * meanDelayCells),
    rightCells: 0,
  };
}

/**
 * Transform log returns at several temporal scales.
 *
 * `returns[i]` is the signed log-price change in one cell. Output has rate
 * units (log change per millisecond), because the cell mass is divided by
 * `stepMs` before filtering.
 */
export function computeWaveletField(
  returns: Float64Array,
  stepMs: number,
  scalesMs: Float64Array,
  mode: WaveletMode,
  options: Partial<WaveletOptions> = {},
): WaveletField {
  if (!(stepMs > 0) || !Number.isFinite(stepMs)) {
    throw new Error(`computeWaveletField: invalid step ${stepMs}`);
  }
  const opts = { ...DEFAULT_WAVELET_OPTIONS, ...options };
  validateOptions(opts);
  for (const scale of scalesMs) {
    if (!(scale > 0) || !Number.isFinite(scale)) {
      throw new Error(`computeWaveletField: invalid scale ${scale}`);
    }
  }

  return mode === "centered"
    ? centeredGaussianFft(returns, stepMs, scalesMs, opts)
    : causalCascade(returns, stepMs, scalesMs, opts);
}

/** Slow exact implementation retained as the numerical oracle for tests. */
export function computeCenteredGaussianReference(
  returns: Float64Array,
  stepMs: number,
  scalesMs: Float64Array,
  options: Partial<WaveletOptions> = {},
): WaveletField {
  const opts = { ...DEFAULT_WAVELET_OPTIONS, ...options };
  validateOptions(opts);
  return centeredGaussianReference(returns, stepMs, scalesMs, opts);
}

function centeredGaussianReference(
  returns: Float64Array,
  stepMs: number,
  scalesMs: Float64Array,
  opts: WaveletOptions,
): WaveletField {
  const n = returns.length;
  const values = new Float64Array(n * scalesMs.length);
  values.fill(NaN);

  for (let band = 0; band < scalesMs.length; band++) {
    const sigmaCells = scalesMs[band]! / stepMs;
    const radius = Math.max(1, Math.ceil(opts.gaussianCutoff * sigmaCells));
    const weights = new Float64Array(radius * 2 + 1);
    let weightSum = 0;
    for (let k = -radius; k <= radius; k++) {
      const w = Math.exp(-0.5 * (k / sigmaCells) ** 2);
      weights[k + radius] = w;
      weightSum += w;
    }
    for (let i = radius; i < n - radius; i++) {
      let sum = 0;
      let valid = true;
      for (let k = -radius; k <= radius; k++) {
        const delta = returns[i - k]!;
        if (!Number.isFinite(delta)) {
          valid = false;
          break;
        }
        sum += (delta / stepMs) * weights[k + radius]!;
      }
      if (valid) values[band * n + i] = sum / weightSum;
    }
  }
  return { values, bandCount: scalesMs.length, sampleCount: n };
}

interface KernelSpectrum {
  readonly radius: number;
  readonly real: Float64Array;
  readonly imaginary: Float64Array;
}

interface KernelBank {
  readonly nfft: number;
  readonly spectra: readonly KernelSpectrum[];
}

const KERNEL_CACHE = new Map<string, KernelBank>();
const MAX_KERNEL_CACHE_ENTRIES = 4;

function centeredGaussianFft(
  returns: Float64Array,
  stepMs: number,
  scalesMs: Float64Array,
  opts: WaveletOptions,
): WaveletField {
  const n = returns.length;
  const values = new Float64Array(n * scalesMs.length);
  values.fill(NaN);
  if (n === 0 || scalesMs.length === 0) {
    return { values, bandCount: scalesMs.length, sampleCount: n };
  }

  let maxRadius = 0;
  for (const scaleMs of scalesMs) {
    maxRadius = Math.max(maxRadius, Math.ceil(opts.gaussianCutoff * (scaleMs / stepMs)));
  }
  const nfft = nextPowerOfTwo(n + maxRadius * 2);
  const bank = kernelBank(nfft, stepMs, scalesMs, opts.gaussianCutoff);

  const signalReal = new Float64Array(nfft);
  const signalImaginary = new Float64Array(nfft);
  const invalidPrefix = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const delta = returns[i]!;
    const valid = Number.isFinite(delta);
    signalReal[i] = valid ? delta / stepMs : 0;
    invalidPrefix[i + 1] = invalidPrefix[i]! + (valid ? 0 : 1);
  }
  fft(signalReal, signalImaginary);

  const workReal = new Float64Array(nfft);
  const workImaginary = new Float64Array(nfft);
  for (let band = 0; band < bank.spectra.length; band++) {
    const spectrum = bank.spectra[band]!;
    for (let k = 0; k < nfft; k++) {
      const ar = signalReal[k]!;
      const ai = signalImaginary[k]!;
      const br = spectrum.real[k]!;
      const bi = spectrum.imaginary[k]!;
      workReal[k] = ar * br - ai * bi;
      workImaginary[k] = ar * bi + ai * br;
    }
    fft(workReal, workImaginary, true);

    const radius = spectrum.radius;
    const offset = band * n;
    for (let i = radius; i < n - radius; i++) {
      if (invalidPrefix[i + radius + 1]! !== invalidPrefix[i - radius]!) continue;
      // Standard linear convolution with a [0, 2r] kernel is centered at i+r.
      values[offset + i] = workReal[i + radius]!;
    }
  }
  return { values, bandCount: scalesMs.length, sampleCount: n };
}

function kernelBank(
  nfft: number,
  stepMs: number,
  scalesMs: Float64Array,
  cutoff: number,
): KernelBank {
  const scaleCells = [...scalesMs].map((scale) => scale / stepMs);
  const key = `${nfft}|${cutoff}|${scaleCells.map((s) => s.toPrecision(12)).join(",")}`;
  const cached = KERNEL_CACHE.get(key);
  if (cached !== undefined) return cached;

  const spectra: KernelSpectrum[] = [];
  for (const sigmaCells of scaleCells) {
    const radius = Math.max(1, Math.ceil(cutoff * sigmaCells));
    const real = new Float64Array(nfft);
    const imaginary = new Float64Array(nfft);
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const weight = Math.exp(-0.5 * (k / sigmaCells) ** 2);
      real[k + radius] = weight;
      sum += weight;
    }
    for (let k = 0; k <= radius * 2; k++) real[k] = real[k]! / sum;
    fft(real, imaginary);
    spectra.push({ radius, real, imaginary });
  }

  const bank = { nfft, spectra };
  KERNEL_CACHE.set(key, bank);
  if (KERNEL_CACHE.size > MAX_KERNEL_CACHE_ENTRIES) {
    const oldest = KERNEL_CACHE.keys().next().value as string | undefined;
    if (oldest !== undefined) KERNEL_CACHE.delete(oldest);
  }
  return bank;
}

function causalCascade(
  returns: Float64Array,
  stepMs: number,
  scalesMs: Float64Array,
  opts: WaveletOptions,
): WaveletField {
  const n = returns.length;
  const values = new Float64Array(n * scalesMs.length);
  values.fill(NaN);

  for (let band = 0; band < scalesMs.length; band++) {
    // Equal first-order stages form an Erlang kernel. Choosing each stage's
    // time constant as sigma/sqrt(K) gives the cascade variance sigma².
    const stageTauMs = scalesMs[band]! / Math.sqrt(opts.causalStages);
    const alpha = 1 - Math.exp(-stepMs / stageTauMs);
    const meanDelayMs = opts.causalStages * stageTauMs;
    const warmupSamples = Math.ceil((opts.causalWarmup * meanDelayMs) / stepMs);
    const state = new Float64Array(opts.causalStages);
    let validRun = 0;

    for (let i = 0; i < n; i++) {
      const delta = returns[i]!;
      if (!Number.isFinite(delta)) {
        state.fill(0);
        validRun = 0;
        continue;
      }
      let x = delta / stepMs;
      for (let stage = 0; stage < state.length; stage++) {
        const next = state[stage]! + alpha * (x - state[stage]!);
        state[stage] = next;
        x = next;
      }
      validRun++;
      if (validRun >= warmupSamples) values[band * n + i] = x;
    }
  }
  return { values, bandCount: scalesMs.length, sampleCount: n };
}

function validateOptions(opts: WaveletOptions): void {
  if (!(opts.gaussianCutoff > 0)) throw new Error("gaussianCutoff must be positive");
  if (!Number.isInteger(opts.causalStages) || opts.causalStages < 1) {
    throw new Error("causalStages must be a positive integer");
  }
  if (!(opts.causalWarmup > 0)) throw new Error("causalWarmup must be positive");
}
