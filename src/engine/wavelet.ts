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

const DEFAULT_WAVELET_OPTIONS: WaveletOptions = {
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
 * Output interval that must be exact. A centered transform may use circular
 * convolution when the caller has already supplied enough context around this
 * interval; samples outside the interval are then intentionally unspecified.
 */
export interface WaveletWindow {
  readonly start: number;
  readonly count: number;
}

/** Persistent buffers reused by one heatmap row across renders. */
export class WaveletWorkspace implements WaveletField {
  values = new Float64Array(0);
  bandCount = 0;
  sampleCount = 0;
  signalReal = new Float64Array(0);
  signalImaginary = new Float64Array(0);
  workReal = new Float64Array(0);
  workImaginary = new Float64Array(0);
  causalState = new Float64Array(0);

  prepareField(sampleCount: number, bandCount: number): Float64Array {
    this.sampleCount = sampleCount;
    this.bandCount = bandCount;
    const length = sampleCount * bandCount;
    if (this.values.length !== length) this.values = new Float64Array(length);
    return this.values;
  }

  ensureFft(length: number): void {
    if (this.signalReal.length === length) return;
    this.signalReal = new Float64Array(length);
    this.signalImaginary = new Float64Array(length);
    this.workReal = new Float64Array(length);
    this.workImaginary = new Float64Array(length);
  }

  ensureCausalState(stages: number): Float64Array {
    if (this.causalState.length !== stages) this.causalState = new Float64Array(stages);
    return this.causalState;
  }
}

/**
 * Convert ZOH log-price samples at cell edges into return impulses located at
 * those same timestamps. `out[i]` uses only edges at or before `i`; this is
 * essential for a genuinely causal rendering. Unknown edges represent no
 * observed impulse and therefore contribute zero.
 */
export function signalEdgesToDeltas(logPrice: Float64Array, reuse?: Float64Array): Float64Array {
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

/**
 * Report which visible transform cells receive a new selected observation.
 *
 * `sampleTime` is parallel to the ZOH price-edge grid. A held observation may
 * supply many edges, but it is counted only when its identity advances. This
 * makes density describe the exact reconstruction consumed by the transform,
 * not unrelated coarser/finer observations that happen to remain cached.
 */
export function usedSampleDensity(
  sampleTime: Float64Array,
  start: number,
  count: number,
  reuse?: Float64Array,
): Float64Array {
  if (!Number.isInteger(start) || !Number.isInteger(count) || start < 1 || count < 0) {
    throw new Error(`usedSampleDensity: invalid window ${start}+${count}`);
  }
  if (start + count > sampleTime.length) {
    throw new Error(
      `usedSampleDensity: window ${start}..${start + count} exceeds ${sampleTime.length}`,
    );
  }
  const density = reuse?.length === count ? reuse : new Float64Array(count);
  for (let x = 0; x < count; x++) {
    const index = start + x;
    const current = sampleTime[index]!;
    const previous = sampleTime[index - 1]!;
    density[x] =
      Number.isFinite(current) && (!Number.isFinite(previous) || current > previous) ? 1 : 0;
  }
  return density;
}

/** Context required for the largest scale, expressed in input cells. */
export function kernelContext(
  mode: WaveletMode,
  maxSigmaCells: number,
  options?: Partial<WaveletOptions>,
): KernelContext {
  const opts = resolveOptions(options);
  validateOptions(opts);
  if (!(maxSigmaCells > 0) || !Number.isFinite(maxSigmaCells)) {
    throw new Error(`kernelContext: invalid sigma ${maxSigmaCells}`);
  }
  if (mode === "centered") {
    const cells = Math.ceil(opts.gaussianCutoff * maxSigmaCells);
    return { leftCells: cells, rightCells: cells };
  }
  const meanDelayCells = Math.sqrt(opts.causalStages) * maxSigmaCells;
  return { leftCells: Math.ceil(opts.causalWarmup * meanDelayCells), rightCells: 0 };
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
  options?: Partial<WaveletOptions>,
  workspace: WaveletWorkspace = new WaveletWorkspace(),
  validWindow?: WaveletWindow,
): WaveletField {
  if (!(stepMs > 0) || !Number.isFinite(stepMs)) {
    throw new Error(`computeWaveletField: invalid step ${stepMs}`);
  }
  const opts = resolveOptions(options);
  validateOptions(opts);
  for (const scale of scalesMs) {
    if (!(scale > 0) || !Number.isFinite(scale)) {
      throw new Error(`computeWaveletField: invalid scale ${scale}`);
    }
  }

  return mode === "centered"
    ? centeredGaussianFft(returns, stepMs, scalesMs, opts, workspace, validWindow)
    : causalCascade(returns, stepMs, scalesMs, opts, workspace);
}

/** Slow exact implementation retained as the numerical oracle for tests. */
export function computeCenteredGaussianReference(
  returns: Float64Array,
  stepMs: number,
  scalesMs: Float64Array,
  options?: Partial<WaveletOptions>,
): WaveletField {
  const opts = resolveOptions(options);
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
  /** Spectrum of an even, zero-centered kernel; imaginary components are zero. */
  readonly real: Float64Array;
}

interface KernelBank {
  readonly nfft: number;
  readonly spectra: readonly KernelSpectrum[];
}

const KERNEL_CACHE = new Map<string, KernelBank>();
// A handful of active row geometries is normal. Keeping one entry caused every
// differently-sized row to evict the previous row's bank on every frame.
const MAX_KERNEL_CACHE_ENTRIES = 8;

function centeredGaussianFft(
  returns: Float64Array,
  stepMs: number,
  scalesMs: Float64Array,
  opts: WaveletOptions,
  workspace: WaveletWorkspace,
  validWindow: WaveletWindow | undefined,
): WaveletField {
  const n = returns.length;
  const values = workspace.prepareField(n, scalesMs.length);
  if (n === 0 || scalesMs.length === 0) return workspace;

  let maxRadius = 0;
  for (const scaleMs of scalesMs) {
    maxRadius = Math.max(maxRadius, Math.ceil(opts.gaussianCutoff * (scaleMs / stepMs)));
  }
  // The renderer supplies max-radius context on both sides of the visible
  // interval. Circular convolution is therefore identical to linear
  // convolution inside that interval, so no second round of FFT padding is
  // necessary. Full-field callers retain the conventional linear size.
  let nfftInputLength = n + maxRadius * 2;
  if (validWindow !== undefined) {
    const { start, count } = validWindow;
    if (!Number.isInteger(start) || !Number.isInteger(count) || count < 0) {
      throw new Error(`centeredGaussianFft: invalid window ${start}+${count}`);
    }
    if (start < maxRadius || start + count > n - maxRadius) {
      throw new Error(
        `centeredGaussianFft: window ${start}..${start + count} lacks radius ${maxRadius} context in ${n} samples`,
      );
    }
    nfftInputLength = n;
  }
  const nfft = nextPowerOfTwo(nfftInputLength);
  const bank = kernelBank(nfft, stepMs, scalesMs, opts.gaussianCutoff);

  workspace.ensureFft(nfft);
  const { signalReal, signalImaginary, workReal, workImaginary } = workspace;
  signalReal.fill(0);
  signalImaginary.fill(0);
  for (let i = 0; i < n; i++) {
    const delta = returns[i]!;
    signalReal[i] = Number.isFinite(delta) ? delta / stepMs : 0;
  }
  fft(signalReal, signalImaginary);

  // Two real filtered bands can share one complex inverse FFT:
  // IFFT(A + iB) = a + ib when A/B are the spectra of real outputs a/b.
  for (let band = 0; band < bank.spectra.length; band += 2) {
    const spectrumA = bank.spectra[band]!.real;
    const spectrumB = bank.spectra[band + 1]?.real;
    for (let k = 0; k < nfft; k++) {
      const xr = signalReal[k]!;
      const xi = signalImaginary[k]!;
      const ka = spectrumA[k]!;
      if (spectrumB === undefined) {
        workReal[k] = xr * ka;
        workImaginary[k] = xi * ka;
      } else {
        const kb = spectrumB[k]!;
        workReal[k] = xr * ka - xi * kb;
        workImaginary[k] = xi * ka + xr * kb;
      }
    }
    fft(workReal, workImaginary, true);

    const offsetA = band * n;
    const offsetB = offsetA + n;
    for (let i = 0; i < n; i++) {
      values[offsetA + i] = workReal[i]!;
      if (spectrumB !== undefined) values[offsetB + i] = workImaginary[i]!;
    }
  }
  return workspace;
}

function kernelBank(
  nfft: number,
  stepMs: number,
  scalesMs: Float64Array,
  cutoff: number,
): KernelBank {
  let key = `${nfft}|${cutoff}`;
  for (const scale of scalesMs) key += `|${(scale / stepMs).toPrecision(12)}`;
  const cached = KERNEL_CACHE.get(key);
  if (cached !== undefined) {
    // Promote hits so occasional resize geometries, not active rows, are evicted.
    KERNEL_CACHE.delete(key);
    KERNEL_CACHE.set(key, cached);
    return cached;
  }

  const spectra: KernelSpectrum[] = [];
  const imaginary = new Float64Array(nfft);
  for (const scale of scalesMs) {
    const sigmaCells = scale / stepMs;
    const radius = Math.max(1, Math.ceil(cutoff * sigmaCells));
    const real = new Float64Array(nfft);
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      const weight = Math.exp(-0.5 * (k / sigmaCells) ** 2);
      real[k < 0 ? nfft + k : k] = weight;
      sum += weight;
    }
    for (let k = -radius; k <= radius; k++) {
      const index = k < 0 ? nfft + k : k;
      real[index] = real[index]! / sum;
    }
    imaginary.fill(0);
    fft(real, imaginary);
    spectra.push({ real });
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
  workspace: WaveletWorkspace,
): WaveletField {
  const n = returns.length;
  const values = workspace.prepareField(n, scalesMs.length);
  const state = workspace.ensureCausalState(opts.causalStages);

  for (let band = 0; band < scalesMs.length; band++) {
    // Equal first-order stages form an Erlang kernel. Choosing each stage's
    // time constant as sigma/sqrt(K) gives the cascade variance sigma².
    const stageTauMs = scalesMs[band]! / Math.sqrt(opts.causalStages);
    const alpha = 1 - Math.exp(-stepMs / stageTauMs);
    state.fill(0);

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
  return workspace;
}

function resolveOptions(options: Partial<WaveletOptions> | undefined): WaveletOptions {
  return options === undefined
    ? DEFAULT_WAVELET_OPTIONS
    : { ...DEFAULT_WAVELET_OPTIONS, ...options };
}

function validateOptions(opts: WaveletOptions): void {
  if (!(opts.gaussianCutoff > 0)) throw new Error("gaussianCutoff must be positive");
  if (!Number.isInteger(opts.causalStages) || opts.causalStages < 1) {
    throw new Error("causalStages must be a positive integer");
  }
  if (!(opts.causalWarmup > 0)) throw new Error("causalWarmup must be positive");
}
