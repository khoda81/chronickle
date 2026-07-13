/** Exchange-facing price fetch contract. */

import { Range } from "../../engine/range.ts";
import { PricePoint } from "../../domain.ts";

export interface FetchRangeOptions {
  /** Broker-clamped historical range; `range.max` is never after wall-clock now. */
  readonly range: Range;
  /** Maximum acceptable sample spacing requested by the renderer. */
  readonly maxDeltaTMs: number;
}

export interface FetchRangeResult {
  /** Raw observations actually returned. The broker validates, sorts and clips them. */
  readonly points: readonly PricePoint[];
  /**
   * Adapter hint for a single/last sample's expected lifetime. With two or
   * more samples the broker derives interval resolution from their timestamps.
   */
  readonly resolutionHintMs?: number;
  /**
   * Range the remote source actually searched, after pagination/caps. The
   * broker clips this to the request and marks only unsupported subranges as
   * empty for this exact request quality. Required for an empty response.
   */
  readonly searchedRange?: Range;
}

export interface Fetcher {
  /** Run at most one request at a time for this source instance. */
  readonly serializeRequests?: boolean;
  /** A failed request blocks every range until its retry timer expires. */
  readonly sourceWideBackoff?: boolean;
  /** Poll delay when a live candle boundary has passed but the source still returns the old candle. */
  readonly liveRetryDelayMs?: number;

  fetchRange(opts: FetchRangeOptions): Promise<FetchRangeResult>;

  /** Exchange-specific retry/rate-limit policy. Defaults to bounded exponential backoff. */
  retryDelayMs?(error: unknown, attempt: number): number;

  /** Clear adapter-owned response/request caches during an explicit reload. */
  clearCache?(): void;

  streamTick?(onPoint: (p: PricePoint) => void): () => void;
}
