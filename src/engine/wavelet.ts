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

/**
 * Convert ZOH log-price samples at cell edges into return impulses located at
 * those same timestamps. `out[i]` uses only edges at or before `i`; this is
 * essential for a genuinely causal rendering. Unknown edges represent no
 * observed impulse and therefore contribute zero.
 */
export function logPriceEdgesToReturns(logPrice: Float64Array, reuse?: Float64Array): Float64Array {
  const out = reuse?.length === logPrice.length ? reuse : new Float64Array(logPrice.length);
  if (out.length === 0) return out;
  out[0] = 0;
  for (let i = 1; i < logPrice.length; i++) {
    const previous = logPrice[i - 1]!;
    const current = logPrice[i]!;
    out[i] = Number.isFinite(previous) && Number.isFinite(current) ? current - previous : 0;
  }
  return out;
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
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const source = i - k;
        if (source < 0 || source >= n) continue;
        const raw = returns[source]!;
        const delta = Number.isFinite(raw) ? raw : 0;
        sum += (delta / stepMs) * weights[k + radius]!;
      }
      values[band * n + i] = sum / weightSum;
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
// A per-row transform can contain hundreds of spectra. Retaining only the
// active geometry prevents resize history from turning into a large memory
// cache; the rendered image cache still makes hover-only redraws free.
const MAX_KERNEL_CACHE_ENTRIES = 1;

function centeredGaussianFft(
  returns: Float64Array,
  stepMs: number,
  scalesMs: Float64Array,
  opts: WaveletOptions,
): WaveletField {
  const n = returns.length;
  const values = new Float64Array(n * scalesMs.length);
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
  for (let i = 0; i < n; i++) {
    const delta = returns[i]!;
    signalReal[i] = Number.isFinite(delta) ? delta / stepMs : 0;
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
    for (let i = 0; i < n; i++) {
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

  for (let band = 0; band < scalesMs.length; band++) {
    // Equal first-order stages form an Erlang kernel. Choosing each stage's
    // time constant as sigma/sqrt(K) gives the cascade variance sigma².
    const stageTauMs = scalesMs[band]! / Math.sqrt(opts.causalStages);
    const alpha = 1 - Math.exp(-stepMs / stageTauMs);
    const state = new Float64Array(opts.causalStages);

    for (let i = 0; i < n; i++) {
      const raw = returns[i]!;
      const delta = Number.isFinite(raw) ? raw : 0;
      let x = delta / stepMs;
      for (let stage = 0; stage < state.length; stage++) {
        const next = state[stage]! + alpha * (x - state[stage]!);
        state[stage] = next;
        x = next;
      }
      values[band * n + i] = x;
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
