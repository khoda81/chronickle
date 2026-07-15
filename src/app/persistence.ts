import type { PaletteName } from "../engine/ramp.ts";
import type { TimelinePlayback } from "../engine/timeline.ts";
import type { WaveletMode } from "../engine/wavelet.ts";

const STORAGE_KEY = "chronickle.ui";
const STORAGE_VERSION = 3;
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
  readonly version: 3;
  readonly viewport?: { readonly min: number; readonly max: number };
  readonly playback: TimelinePlayback;
  readonly newsHeight?: number;
  readonly charts: readonly PersistedChart[];
}

interface LegacyUiState {
  readonly viewport?: { readonly min?: unknown; readonly max?: unknown };
  readonly waveletMode?: unknown;
  readonly playback?: unknown;
  readonly newsHeight?: unknown;
  readonly charts?: readonly unknown[];
}

export interface UiStatePersistence {
  schedule(): void;
  flush(): void;
  dispose(): void;
}

export function loadUiState(): PersistedUiState {
  const fallback: PersistedUiState = {
    version: STORAGE_VERSION,
    playback: { mode: "following", anchor: 0.85 },
    charts: [],
  };
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return fallback;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return fallback;
    if (parsed.version === STORAGE_VERSION) return parseV3(parsed);
    return migrateLegacy(parsed as LegacyUiState, fallback);
  } catch {
    return fallback;
  }
}

export function createUiStatePersistence(readState: () => PersistedUiState): UiStatePersistence {
  let timer: number | null = null;
  let lastRequestAt = 0;

  const write = (): void => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(readState()));
  };

  const scheduleTimer = (delayMs: number): void => {
    timer = window.setTimeout(() => {
      const remaining = DEBOUNCE_MS - (performance.now() - lastRequestAt);
      if (remaining > 0) {
        scheduleTimer(remaining);
        return;
      }
      timer = null;
      write();
    }, delayMs);
  };

  return {
    schedule(): void {
      lastRequestAt = performance.now();
      if (timer === null) scheduleTimer(DEBOUNCE_MS);
    },
    flush(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      write();
    },
    dispose(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

function parseV3(value: Record<string, unknown>): PersistedUiState {
  return {
    version: STORAGE_VERSION,
    viewport: parseViewport(value.viewport),
    playback: parsePlayback(value.playback),
    newsHeight: finitePositive(value.newsHeight),
    charts: parseCharts(value.charts, "centered"),
  };
}

function migrateLegacy(value: LegacyUiState, fallback: PersistedUiState): PersistedUiState {
  const previousGlobalMode = parseWaveletMode(value.waveletMode, "centered");
  return {
    ...fallback,
    viewport: parseViewport(value.viewport),
    playback: parsePlayback(value.playback),
    newsHeight: finitePositive(value.newsHeight),
    charts: parseCharts(value.charts, previousGlobalMode),
  };
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

function parseViewport(value: unknown): { readonly min: number; readonly max: number } | undefined {
  if (!isRecord(value)) return undefined;
  const min = finiteNumber(value.min);
  const max = finiteNumber(value.max);
  return min !== undefined && max !== undefined && min < max ? { min, max } : undefined;
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
