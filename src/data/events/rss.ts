/**
 * RSS/Atom ingestion.
 *
 * Browser CORS blocks direct RSS fetching, so we route through a CORS proxy.
 * The proxy returns the raw XML, which we parse with `DOMParser` and
 * normalize into a structured `ParsedFeed`.
 *
 * Parser notes:
 *  - Supports RSS 2.0 (<item>, <pubDate>, <link>text</link>) and Atom 1.0
 *    (<entry>, <published>/<updated>, <link href=… />).
 *  - Atom <link> selection prefers rel="alternate" (the human-readable
 *    permalink); falls back to the first link that is not rel="self".
 *  - Dates: tries pubDate, published, updated, and Dublin Core <dc:date>
 *    (namespace-agnostic via local-name matching).
 *  - Extracts the feed-level <title> for display naming.
 *  - Extracts <atom:link rel="next"> for RFC 5005 archive pagination.
 *  - Extracts <description> / <summary> / <content:encoded> as a summary
 *    for tooltip enrichment (HTML stripped to plain text).
 *
 * Per-item failures degrade gracefully: a single malformed item is skipped
 * rather than poisoning the whole feed. Feed-level failures (malformed XML,
 * Cloudflare HTML block, no items) throw loudly.
 */

import type { NewsEvent, RssFeed } from "../../domain.ts";

const DEFAULT_PROXY = "https://corsproxy.io/?url=";

/**
 * Result of parsing a single feed document.
 *
 * `nextArchiveUrl` is the RFC 5005 `<atom:link rel="next">` href, when
 * present — used by the EventFetcher to backfill older history page by page.
 */
export interface ParsedFeed {
  /** Feed-level <title>, or empty string if absent. */
  readonly title: string;
  readonly events: readonly NewsEvent[];
  /** href of <atom:link rel="next">, or null if the feed has no archive link. */
  readonly nextArchiveUrl: string | null;
}

export interface FetchEventsOptions {
  readonly feeds?: readonly RssFeed[];
  /** CORS proxy base. The RSS URL is appended (URL-encoded) after this prefix. */
  readonly proxy?: string;
  /** Per-feed fetch timeout in ms. */
  readonly timeoutMs?: number;
}

/**
 * Fetch and parse a single RSS feed.
 * @throws on fetch failure, parse failure, or missing pubDate.
 */
export async function fetchFeed(
  feed: RssFeed,
  proxy: string,
  timeoutMs: number,
): Promise<ParsedFeed> {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException(`${feed.source} timed out after ${timeoutMs}ms`, "TimeoutError"),
      ),
    timeoutMs,
  );

  try {
    const url = `${proxy}${encodeURIComponent(feed.url)}`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Feed ${feed.source} failed: ${res.status}`);
    }
    const xml = await res.text();
    return parseRssXml(xml, feed.id);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse RSS 2.0 / Atom 1.0 XML into a ParsedFeed.
 * @throws on malformed XML, Cloudflare HTML block, or zero items.
 */
function parseRssXml(xml: string, feedId: string): ParsedFeed {
  const doc = new DOMParser().parseFromString(xml, "application/xml");

  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    throw new Error(`Malformed XML from feed ${feedId}: ${parseError.textContent ?? ""}`);
  }

  // Cloudflare / anti-bot often returns an HTML page instead of XML.
  if (doc.documentElement.nodeName.toLowerCase() === "html") {
    throw new Error(`Feed ${feedId} blocked the proxy (returned HTML instead of XML).`);
  }

  const root = doc.documentElement;
  const isAtom = root.nodeName.toLowerCase() === "feed";

  // Feed-level title: RSS <channel><title>, Atom <feed><title>.
  const feedTitle = textOf(root.querySelector("title")) ?? "";

  // RFC 5005 archive link: <atom:link rel="next"> at the feed level.
  // querySelector with an attribute selector works across namespaces in
  // DOMParser's XML mode (local-name match).
  const nextArchiveUrl = nextArchiveLink(root);

  const items = root.querySelectorAll("item, entry");
  if (items.length === 0) {
    throw new Error(`No news items found in feed ${feedId}.`);
  }

  const events: NewsEvent[] = [];
  for (const item of Array.from(items)) {
    const title = textOf(item.querySelector("title"));
    const link = isAtom ? atomEntryLink(item) : textOf(item.querySelector("link"));
    const pubDate = entryDate(item);
    const summary = entrySummary(item);

    // Graceful degradation: skip a malformed item instead of killing the feed.
    if (!title || !link || !pubDate) continue;

    const t = Date.parse(pubDate);
    if (Number.isFinite(t)) {
      events.push({ t, title, link, summary, feedId });
    }
  }

  events.sort((a, b) => a.t - b.t);
  return { title: feedTitle, events, nextArchiveUrl };
}

/** Default CORS proxy base, exported for the EventFetcher. */
export const defaultProxy = DEFAULT_PROXY;

/* ----------------------------- helpers ------------------------------ */

/** Trimmed text content of an element, or null if absent/empty. */
function textOf(el: Element | null): string | null {
  const s = el?.textContent?.trim();
  return s && s.length > 0 ? s : null;
}

/**
 * Atom entries can have multiple <link> elements. Prefer rel="alternate"
 * (the permalink); fall back to the first link that is not rel="self".
 */
function atomEntryLink(entry: Element): string | null {
  const links = Array.from(entry.querySelectorAll("link"));
  if (links.length === 0) return null;
  const alternate = links.find((l) => (l.getAttribute("rel") ?? "alternate") === "alternate");
  if (alternate) return alternate.getAttribute("href")?.trim() ?? null;
  const nonSelf = links.find((l) => l.getAttribute("rel") !== "self");
  if (nonSelf) return nonSelf.getAttribute("href")?.trim() ?? null;
  return links[0]!.getAttribute("href")?.trim() ?? null;
}

/**
 * Extract the publication date of an entry, trying the common elements
 * across RSS 2.0, Atom 1.0, and Dublin Core. Returns the raw date string
 * (caller parses); null if none found.
 */
function entryDate(entry: Element): string | null {
  // Standard RSS/Atom elements first.
  const standard =
    textOf(entry.querySelector("pubDate")) ??
    textOf(entry.querySelector("published")) ??
    textOf(entry.querySelector("updated"));
  if (standard) return standard;

  // Dublin Core <dc:date> — querySelector doesn't match namespaced tags by
  // prefix reliably across parsers, so walk children by local name.
  for (const child of Array.from(entry.children)) {
    if (localName(child) === "date" && child.namespaceURI?.includes("purl.org/dc/")) {
      const s = child.textContent?.trim();
      if (s) return s;
    }
  }
  return null;
}

/**
 * Extract a plain-text summary from <description> (RSS),
 * <content:encoded> (RSS extended), or <summary> (Atom). HTML tags are
 * stripped and whitespace collapsed.
 */
function entrySummary(entry: Element): string {
  const raw =
    textOf(entry.querySelector("description")) ??
    contentEncoded(entry) ??
    textOf(entry.querySelector("summary"));
  if (!raw) return "";
  return stripHtml(raw).slice(0, 500);
}

/** <content:encoded> — namespaced; walk children by local name. */
function contentEncoded(entry: Element): string | null {
  for (const child of Array.from(entry.children)) {
    if (
      localName(child) === "encoded" &&
      child.namespaceURI?.includes("purl.org/rss/1.0/modules/content/")
    ) {
      return child.textContent?.trim() ?? null;
    }
  }
  return null;
}

/** Feed-level <atom:link rel="next"> href, or null. */
function nextArchiveLink(root: Element): string | null {
  for (const link of Array.from(root.querySelectorAll("link"))) {
    if (link.getAttribute("rel") === "next") {
      return link.getAttribute("href")?.trim() ?? null;
    }
  }
  return null;
}

/** Local name of an element, ignoring any namespace prefix. */
function localName(el: Element): string {
  const name = el.nodeName;
  const colon = name.indexOf(":");
  return colon === -1 ? name.toLowerCase() : name.slice(colon + 1).toLowerCase();
}

/**
 * Strip HTML tags and collapse whitespace. Uses the DOM to decode entities
 * safely rather than a regex on the raw string.
 */
function stripHtml(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  const text = div.textContent ?? "";
  return text.replace(/\s+/g, " ").trim();
}
