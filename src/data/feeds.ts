/**
 * FeedRegistry: the single source of truth for which RSS/Atom feeds are
 * active, their stable ids, display names, and derived colors.
 *
 * Invariants (enforced structurally):
 *  - `id` is `hashUrl(url)` — deterministic; the same URL always maps to the
 *    same id, so re-adding a feed after removal restores its identity.
 *  - Each feed is assigned a stable `colorIndex` at registration. Indices are
 *    **never renumbered** on removal: a small tombstone set records freed
 *    indices and new feeds reuse the lowest freed index before growing the
 *    range. This keeps colors stable across add/remove cycles.
 *  - `color` is derived from `colorIndex` via `idToColor` and stored on the
 *    feed so the renderer never recomputes it.
 *
 * Persistence: the registry serializes to `localStorage` under
 * `STORAGE_KEY`. Defaults are seeded on first load; user-added feeds are
 * merged on top. All feeds (including defaults) are removable and the full
 * list is persisted.
 */

import type { RssFeed } from "../domain.ts";
import { idToColor } from "./color.ts";

const STORAGE_KEY = "chronicle.feeds";

/**
 * Default feeds seeded on first load. Listed in a deliberate order so the
 * initial color assignment is stable and visually spread.
 */
export const DEFAULT_FEEDS: readonly RssFeed[] = [
  {
    id: "reuters",
    source: "Reuters",
    url: "https://www.reutersagency.com/feed/?best-top-news&post_type=best",
    color: idToColor(0),
  },
  {
    id: "aljazeera",
    source: "Al Jazeera",
    url: "https://www.aljazeera.com/xml/rss/all.xml",
    color: idToColor(1),
  },
  {
    id: "bbc",
    source: "BBC World",
    url: "http://feeds.bbci.co.uk/news/world/rss.xml",
    color: idToColor(2),
  },
  {
    id: "yahoo",
    source: "Yahoo World",
    url: "https://news.yahoo.com/rss/world",
    color: idToColor(3),
  },
  {
    id: "nyt",
    source: "NYT World",
    url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    color: idToColor(4),
  },
];

/**
 * A minimal, deterministic string hash (FNV-1a 32-bit). Good enough for feed
 * ids — we want stability and speed, not cryptographic strength. Output is a
 * base36 string for compactness.
 */
export function hashUrl(url: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    // FNV multiplier (16777619) mod 2^32, via Math.imul to stay in 32-bit.
    h = Math.imul(h, 0x01000193);
  }
  // Force unsigned and base36-encode.
  return (h >>> 0).toString(36);
}

interface StoredFeed {
  readonly id: string;
  readonly source: string;
  readonly url: string;
  readonly colorIndex: number;
}

export class FeedRegistry {
  private readonly feeds = new Map<string, RssFeed>();
  private readonly colorIndex = new Map<string, number>();
  /** Indices freed by removal, available for reuse before growing the range. */
  private readonly freeIndices: number[] = [];
  private nextIndex = 0;

  private constructor() {}

  /** Seed a registry with the default feeds. */
  static withDefaults(): FeedRegistry {
    const r = new FeedRegistry();
    for (let i = 0; i < DEFAULT_FEEDS.length; i++) {
      r.addKnown(DEFAULT_FEEDS[i]!, i);
    }
    return r;
  }

  /**
   * Load from localStorage, falling back to defaults if storage is empty or
   * corrupt. Corrupt entries are surfaced loudly (per AGENTS.md §2): a
   * malformed JSON payload resets to defaults rather than silently swallowing.
   */
  static load(): FeedRegistry {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return FeedRegistry.withDefaults();

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`FeedRegistry: corrupt localStorage at "${STORAGE_KEY}": ${err}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error(`FeedRegistry: expected an array in localStorage, got ${typeof parsed}`);
    }

    const r = new FeedRegistry();
    for (const entry of parsed) {
      if (!isStoredFeed(entry)) {
        throw new Error(`FeedRegistry: malformed feed entry: ${JSON.stringify(entry)}`);
      }
      r.addKnown(
        {
          id: entry.id,
          source: entry.source,
          url: entry.url,
          color: idToColor(entry.colorIndex),
        },
        entry.colorIndex,
      );
    }
    // If storage was empty (e.g. user removed all feeds), seed defaults so
    // the app is never feedless on reload.
    if (r.feeds.size === 0) return FeedRegistry.withDefaults();
    return r;
  }

  /** Persist the current set of feeds to localStorage. */
  save(): void {
    const stored: StoredFeed[] = [];
    for (const f of this.feeds.values()) {
      stored.push({
        id: f.id,
        source: f.source,
        url: f.url,
        colorIndex: this.colorIndex.get(f.id)!,
      });
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  }

  /**
   * Add a feed by URL. Assigns a stable id (hash of URL) and a color index
   * (lowest freed index, else `nextIndex`). If the URL is already registered,
   * returns the existing feed unchanged.
   *
   * `source` is the display name; if omitted, the host is used as a
   * placeholder until the feed is fetched and its real <title> extracted.
   */
  add(url: string, source?: string): RssFeed {
    const id = hashUrl(url);
    const existing = this.feeds.get(id);
    if (existing) return existing;

    const idx = this.freeIndices.pop() ?? this.nextIndex++;
    const feed: RssFeed = {
      id,
      source: source ?? hostOf(url),
      url,
      color: idToColor(idx),
    };
    this.feeds.set(id, feed);
    this.colorIndex.set(id, idx);
    return feed;
  }

  /** Update the display name of an existing feed (e.g. after fetching its <title>). */
  rename(id: string, source: string): void {
    const existing = this.feeds.get(id);
    if (!existing) {
      throw new Error(`FeedRegistry.rename: unknown feed id ${id}`);
    }
    this.feeds.set(id, { ...existing, source });
  }

  /** Remove a feed. Its color index is freed for reuse. */
  remove(id: string): void {
    const idx = this.colorIndex.get(id);
    if (idx === undefined) return;
    this.feeds.delete(id);
    this.colorIndex.delete(id);
    this.freeIndices.push(idx);
  }

  /** All registered feeds, in insertion order (Map preserves it). */
  all(): readonly RssFeed[] {
    return [...this.feeds.values()];
  }

  /** Look up a feed by id, or throw if unknown. */
  get(id: string): RssFeed {
    const f = this.feeds.get(id);
    if (!f) throw new Error(`FeedRegistry.get: unknown feed id ${id}`);
    return f;
  }

  /** Resolve a feed id to its color, or throw if unknown. */
  colorOf(feedId: string): string {
    return this.get(feedId).color;
  }

  /** Number of registered feeds. */
  get size(): number {
    return this.feeds.size;
  }

  /**
   * Internal: insert a feed whose id and color index are already known
   * (used by `withDefaults` and `load`). Claims the given `idx` and advances
   * `nextIndex` past it. Freed indices below `idx` are pruned from
   * `freeIndices` so they are never reused by a later `add` (which would
   * collide with this feed's color).
   */
  private addKnown(feed: RssFeed, idx: number): void {
    if (this.feeds.has(feed.id)) return;
    this.feeds.set(feed.id, feed);
    this.colorIndex.set(feed.id, idx);
    if (idx >= this.nextIndex) this.nextIndex = idx + 1;
    // Drop any freed indices that are >= idx — they belong to feeds loaded
    // later in the same batch and must not be handed out by `add`.
    for (let i = this.freeIndices.length - 1; i >= 0; i--) {
      if (this.freeIndices[i]! >= idx) this.freeIndices.splice(i, 1);
    }
  }
}

/** Extract the hostname from a URL for use as a placeholder display name. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function isStoredFeed(v: unknown): v is StoredFeed {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.source === "string" &&
    typeof o.url === "string" &&
    typeof o.colorIndex === "number"
  );
}
