import { makePersisted, type SyncStorage } from "@solid-primitives/storage";
import { createSignal, type Accessor, type Setter, type Signal } from "solid-js";
import { Interval, type Interval as IntervalValue } from "../core/interval.ts";
import type { PaletteName } from "../engine/ramp.ts";
import type { TimelinePlayback } from "../engine/timeline.ts";
import type { WaveletMode } from "../engine/wavelet.ts";

const STORAGE_KEY = "chronickle.ui";
const STORAGE_VERSION = 4;
const DEBOUNCE_MS = 300;

export interface PersistedChart {
  readonly sourceId: string;
  readonly symbol: string;
  readonly palette?: PaletteName;
  readonly waveletMode?: WaveletMode;
  readonly verticalOffset?: number;
  readonly height?: number;
}

export interface PersistedUiState {
  readonly version: 4;
  readonly viewport: IntervalValue;
  readonly playback: TimelinePlayback;
  readonly newsHeight?: number;
  readonly charts: readonly PersistedChart[];
}

export interface PersistedUiStateController {
  readonly state: Accessor<PersistedUiState>;
  readonly replace: Setter<PersistedUiState>;
  flush(): void;
  dispose(): void;
}

/**
 * Create the persisted workspace snapshot.
 *
 * `makePersisted` owns reading, serialization, and write-through updates.
 * Version migration and validation remain explicit because they encode product
 * semantics rather than generic storage behavior.
 */
export function createPersistedUiState(fallback: PersistedUiState): PersistedUiStateController {
  const storage = createBufferedStorage(localStorage, DEBOUNCE_MS);
  const [state, replace] = makePersisted<PersistedUiState, Signal<PersistedUiState>>(
    createSignal(fallback),
    { name: STORAGE_KEY, storage, deserialize: raw => deserializePersistedUiState(raw, fallback) },
  );

  return { state, replace, flush: storage.flush, dispose: storage.dispose };
}

export function deserializePersistedUiState(
  raw: string,
  fallback: PersistedUiState,
): PersistedUiState {
  try {
    return parsePersistedUiState(JSON.parse(raw) as unknown, fallback);
  } catch {
    return fallback;
  }
}

function parsePersistedUiState(value: unknown, fallback: PersistedUiState): PersistedUiState {
  if (!isRecord(value)) return fallback;

  if (value.version === STORAGE_VERSION) {
    return parseVersion4(value, fallback);
  }

  // Versions 1–3 stored viewport bounds as `{ min, max }`. Earlier versions
  // also stored one global wavelet mode; per-chart values, when present, win.
  if (value.version === 1 || value.version === 2 || value.version === 3) {
    return migrateLegacyState(value, fallback);
  }

  // Do not guess at future schemas. An unsupported version falls back rather
  // than being misinterpreted as a legacy payload.
  return fallback;
}

function parseVersion4(
  value: Record<string, unknown>,
  fallback: PersistedUiState,
): PersistedUiState {
  return {
    version: STORAGE_VERSION,
    viewport: parseCurrentViewport(value.viewport, fallback.viewport),
    playback: parsePlayback(value.playback),
    newsHeight: finitePositive(value.newsHeight),
    charts: parseCharts(value.charts, "centered"),
  };
}

function migrateLegacyState(
  value: Record<string, unknown>,
  fallback: PersistedUiState,
): PersistedUiState {
  const globalWaveletMode = parseWaveletMode(value.waveletMode, "centered");
  return {
    version: STORAGE_VERSION,
    viewport: parseLegacyViewport(value.viewport, fallback.viewport),
    playback: parsePlayback(value.playback),
    newsHeight: finitePositive(value.newsHeight),
    charts: parseCharts(value.charts, globalWaveletMode),
  };
}

function parseCurrentViewport(value: unknown, fallback: IntervalValue): IntervalValue {
  if (!isRecord(value)) return fallback;
  return nonEmptyInterval(value.start, value.end, fallback);
}

function parseLegacyViewport(value: unknown, fallback: IntervalValue): IntervalValue {
  if (!isRecord(value)) return fallback;
  return nonEmptyInterval(value.min, value.max, fallback);
}

function nonEmptyInterval(
  rawStart: unknown,
  rawEnd: unknown,
  fallback: IntervalValue,
): IntervalValue {
  const start = finiteNumber(rawStart);
  const end = finiteNumber(rawEnd);
  if (start === undefined || end === undefined) return fallback;

  const interval = Interval.create(start, end);
  return Interval.isEmpty(interval) ? fallback : interval;
}

function parseCharts(value: unknown, defaultWaveletMode: WaveletMode): readonly PersistedChart[] {
  if (!Array.isArray(value)) return [];

  const charts: PersistedChart[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.sourceId !== "string" ||
      typeof entry.symbol !== "string"
    ) {
      continue;
    }
    charts.push({
      sourceId: entry.sourceId,
      symbol: entry.symbol,
      palette: typeof entry.palette === "string" ? (entry.palette as PaletteName) : undefined,
      waveletMode: parseWaveletMode(entry.waveletMode, defaultWaveletMode),
      verticalOffset: finiteNumber(entry.verticalOffset),
      height: finitePositive(entry.height),
    });
  }
  return charts;
}

function parseWaveletMode(value: unknown, fallback: WaveletMode): WaveletMode {
  if (value === "causal") return "causal";
  if (value === "centered") return "centered";
  return fallback;
}

function parsePlayback(value: unknown): TimelinePlayback {
  if (!isRecord(value)) return { mode: "following", anchor: 0.85 };
  if (value.mode === "paused") return { mode: "paused" };
  if (value.mode !== "following") return { mode: "following", anchor: 0.85 };

  const anchor = finiteNumber(value.anchor);
  return {
    mode: "following",
    anchor: anchor === undefined ? 0.85 : Math.max(0, Math.min(1, anchor)),
  };
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function finitePositive(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface BufferedStorage extends SyncStorage {
  flush(): void;
  dispose(): void;
}

function createBufferedStorage(storage: Storage, delayMs: number): BufferedStorage {
  const pending = new Map<string, string | null>();
  let timer: number | null = null;

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    for (const [key, value] of pending) {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    }
    pending.clear();
  };

  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = window.setTimeout(flush, delayMs);
  };

  return {
    getItem(key): string | null {
      return pending.has(key) ? (pending.get(key) ?? null) : storage.getItem(key);
    },
    setItem(key, value): void {
      pending.set(key, value);
      schedule();
    },
    removeItem(key): void {
      pending.set(key, null);
      schedule();
    },
    flush,
    dispose(): void {
      flush();
    },
  };
}
