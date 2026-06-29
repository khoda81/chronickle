/**
 * FeedWalker: stateful per-feed archive walker.
 *
 * Replaces the stateless `fetchFeed(feed, targetMin)` loop in the old
 * `rssFetcher.ts`. The walker owns:
 *  - `cursor`: the next archive URL to fetch (starts at the feed head, advances
 *    through `<atom:link rel="next">` pages).
 *  - `pages`: a per-feed in-memory cache of already-fetched pages, keyed by
 *    URL. Re-walking toward an older `targetMin` reuses cached pages and only
 *    fetches newly-needed ones — so scrolling left incrementally does not
 *    re-fetch the feed head every time.
 *  - `exhausted`: the archive chain ended (no `next` link on the last page).
 *    Once true, the walker refuses to walk further.
 *  - `failureReason`: a terminal failure (410 Gone, malformed XML). Once set,
 *    the walker refuses to walk further — the broker must not retry.
 *
 * `walk(targetMin, onEvents)` resumes from `cursor` and fetches pages until
 * the oldest event seen is at or before `targetMin`, the archive ends, or a
 * page fails. Each successfully loaded page calls `onEvents(pageEvents)`
 * immediately, so the broker's store is updated incrementally and a mid-walk
 * failure on page N does not lose the events from pages 1..N-1.
 *
 * Failure classification:
 *  - 410 Gone on any page            → `failed` (archive removed; retrying won't help).
 *  - Malformed XML / HTML block      → `failed` (feed is broken).
 *  - Network error / timeout / 5xx   → `backoff` (transient; broker retries with delay).
 *  - Other 4xx                       → `backoff` (might be temporary).
 *  - `MAX_PAGES` safety cap reached  → `backoff` (avoid spinning on a cycling archive).
 */

import type { NewsEvent, RssFeed } from "../../domain.ts";
import { fetchFeed, type ParsedFeed, defaultProxy } from "./rss.ts";

export type WalkOutcome = "exhausted" | "failed" | "backoff";

export interface FeedWalkerOptions {
  readonly proxy?: string;
  readonly timeoutMs?: number;
}

// TODO: Instead of a cap, handle cycling archive links by detecting repeated URLs
/** Safety cap against a misbehaving feed whose "next" link cycles. */
const MAX_PAGES = 200;

export class FeedWalker {
  private readonly feed: RssFeed;
  private readonly proxy: string;
  private readonly timeoutMs: number;

  /** Next URL to fetch. `null` once the archive chain has ended. */
  private cursor: string | null;
  /** Cached pages keyed by URL. Immutable once stored. */
  private readonly pages = new Map<string, ParsedFeed>();
  private _failureReason: string | null = null;

  constructor(feed: RssFeed, opts: FeedWalkerOptions = {}) {
    this.feed = feed;
    this.proxy = opts.proxy ?? defaultProxy;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.cursor = feed.url;
  }

  get failureReason(): string | null {
    return this._failureReason;
  }

  /**
   * Resume the walk toward `targetMin`. Each successfully loaded page calls
   * `onEvents(pageEvents)` with that page's events (sorted ascending by t).
   * Resolves with the walk outcome:
   *  - `exhausted`: the archive chain ended (no `next` link). Terminal.
   *  - `failed`:    a terminal failure occurred. Terminal.
   *  - `backoff`:   a transient failure occurred, or the MAX_PAGES guard hit.
   *                 The broker should retry after a delay.
   *
   * If the walker is already terminal (`exhausted` or `failed`), resolves
   * immediately with that outcome and does not call `onEvents`.
   */
  async walk(
    targetMin: number,
    onEvents: (events: readonly NewsEvent[]) => void,
  ): Promise<WalkOutcome> {
    while (this.cursor !== null) {
      let parsed = this.pages.get(this.cursor);
      if (parsed === undefined) {
        const result = await this.fetchPage(this.cursor);
        if (result.kind !== "ok") {
          // Classify and return. Cached pages already emitted their events;
          // nothing more to do here.
          if (result.kind === "failed") this._failureReason = result.reason;
          return result.kind;
        }

        parsed = result.parsed;
        this.pages.set(this.cursor, parsed);
      }

      // Heuristic stop: a page with zero items and a next link — likely the
      // archive is empty from here. Don't spin.
      if (parsed.events.length === 0) return "exhausted";

      // Emit this page's events. ParsedFeed.events is already sorted ascending.
      this.cursor = parsed.nextArchiveUrl;
      onEvents(parsed.events);

      // Coverage check: oldest event on this page at or before targetMin?
      const oldest = parsed.events[0]!.t;

      // not terminal — just "stop here for now"
      if (oldest <= targetMin && this.cursor !== null) return "backoff";
    }

    return "exhausted";
  }

  /**
   * Fetch and parse a single page. Archive URLs are also routed through the
   * CORS proxy. The feed's id/source/color are preserved so events get the
   * correct feedId.
   */
  private async fetchPage(url: string): Promise<PageFetchResult> {
    console.debug(`Fetching url: ${url}`);
    const pageFeed: RssFeed = { ...this.feed, url };
    try {
      const parsed = await fetchFeed(pageFeed, this.proxy, this.timeoutMs);
      return { kind: "ok", parsed };
    } catch (err) {
      return classifyError(err, url, this.feed.source);
    }
  }
}

type PageFetchResult =
  | { readonly kind: "ok"; readonly parsed: ParsedFeed }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "backoff"; readonly reason: string };

/**
 * Classify a fetch/parse failure into terminal (`failed`) vs transient
 * (`backoff`). Terminal failures are ones where retrying will not help:
 *  - 410 Gone: the archive page was removed.
 *  - Malformed XML / HTML block: the feed itself is broken.
 * Transient failures are everything else (network, timeout, 5xx, 4xx).
 */
function classifyError(err: unknown, url: string, source: string): PageFetchResult {
  const msg = err instanceof Error ? err.message : String(err);

  // 410 Gone — archive removed. Terminal.
  if (msg.includes("410")) {
    return { kind: "failed", reason: `Feed ${source}: 410 Gone at ${url}` };
  }
  // Malformed XML or HTML block — feed is broken. Terminal.
  if (msg.includes("Malformed XML") || msg.includes("blocked the proxy")) {
    return { kind: "failed", reason: `Feed ${source}: ${msg}` };
  }
  // Everything else (network, timeout, 5xx, 4xx) — transient.
  return { kind: "backoff", reason: `Feed ${source}: ${msg}` };
}
