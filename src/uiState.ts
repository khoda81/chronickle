/**
 * Debounced persistence of UI state (viewport + palette) to localStorage.
 *
 * The viewport changes on every pointermove during a pan and every wheel
 * tick during a zoom — writing synchronously on each change would be both
 * laggy (localStorage.setItem is synchronous) and wasteful (thousands of
 * redundant writes during a single drag). Instead, `saveUiState` coalesces
 * rapid calls into a single write 300ms after the last change. `flushUiState`
 * writes synchronously for the `pagehide` path so a tab close mid-debounce
 * doesn't lose the last state.
 *
 * Storage is tolerant: a missing or corrupt payload is treated as "no saved
 * state" and callers fall back to their defaults. We do not throw on corrupt
 * UI state (unlike FeedRegistry, where corrupt feed data is a real error) —
 * UI state is ephemeral preference, not authoritative data.
 */

const KEY = "chronickle.ui";
const DEBOUNCE_MS = 300;

export interface UiState {
  /** Visible time range [min, max] in epoch ms. */
  readonly viewport?: { readonly min: number; readonly max: number };
  /** Active heatmap palette name. */
  readonly palette?: string;
  /** Centered historical view or time-causal available-at-time view. */
  readonly waveletMode?: "centered" | "causal";
}

let saveTimer: number | null = null;
let pending: UiState = {};

/**
 * Load saved UI state, or an empty object if storage is absent/corrupt.
 * Does not throw — UI state is preference, not authoritative data.
 */
export function loadUiState(): UiState {
  const raw = localStorage.getItem(KEY);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) return parsed as UiState;
    return {};
  } catch {
    // Corrupt JSON — ignore and start fresh.
    return {};
  }
}

/**
 * Debounced save. Rapid calls coalesce into one write DEBOUNCE_MS after the
 * last call. The `state` argument is merged into the pending state so
 * independent callers (viewport, palette) don't clobber each other.
 */
export function saveUiState(state: UiState): void {
  pending = { ...pending, ...state };
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    localStorage.setItem(KEY, JSON.stringify(pending));
    pending = {};
    saveTimer = null;
  }, DEBOUNCE_MS) as unknown as number;
}

/**
 * Synchronous flush for the `pagehide` / `beforeunload` path. Cancels any
 * pending debounced write and writes immediately.
 */
export function flushUiState(state: UiState): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const merged = { ...pending, ...state };
  pending = {};
  localStorage.setItem(KEY, JSON.stringify(merged));
}
