/**
 * Chronickle entry point.
 *
 * Wires the data layer (Nobitex trades + RSS) to the canvas timeline, and
 * renders an HTML tooltip on hover. Errors are surfaced explicitly in the
 * status bar rather than swallowed.
 */

import { Timeline } from "./engine/timeline.ts";
import { Range } from "./engine/range.ts";
import { PALETTES, rampPaletteName, setRampPalette, type PaletteName } from "./engine/ramp.ts";
import { Broker } from "./data/price/broker.ts";
import { createNobitexFetcher } from "./data/price/exchanges/nobitexFetcher.ts";
import { EventBroker, fetchFeed, defaultProxy } from "./data/index.ts";
import { FeedRegistry } from "./data/events/feeds.ts";
import { idToColor } from "./data/events/color.ts";
import type { RssFeed } from "./domain.ts";
import { loadUiState, saveUiState, flushUiState } from "./uiState.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Default feeds seeded on first load (or when the user has removed all
 * feeds). Owned by main.ts — the registry itself holds no default policy.
 * Listed in a deliberate order so the initial color assignment is stable
 * and visually spread.
 */
const DEFAULT_FEEDS: readonly RssFeed[] = [
  {
    id: "reuters",
    source: "Reuters",
    url: "https://www.reutersagency.com/feed/?best-top-news&post_type=best",
    color: idToColor(0),
    enabled: true,
  },
  {
    id: "aljazeera",
    source: "Al Jazeera",
    url: "https://www.aljazeera.com/xml/rss/all.xml",
    color: idToColor(1),
    enabled: true,
  },
  {
    id: "bbc",
    source: "BBC World",
    url: "http://feeds.bbci.co.uk/news/world/rss.xml",
    color: idToColor(2),
    enabled: true,
  },
  {
    id: "yahoo",
    source: "Yahoo World",
    url: "https://news.yahoo.com/rss/world",
    color: idToColor(3),
    enabled: true,
  },
  {
    id: "nyt",
    source: "NYT World",
    url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    color: idToColor(4),
    enabled: true,
  },
];

function el<T extends HTMLElement>(tag: string, cls?: string): T {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e as T;
}

function buildApp(): {
  canvas: HTMLCanvasElement;
  tooltip: HTMLDivElement;
  status: HTMLDivElement;
  reload: HTMLButtonElement;
  palette: HTMLSelectElement;
  feedInput: HTMLInputElement;
  feedAdd: HTMLButtonElement;
  feedList: HTMLDivElement;
} {
  const app = document.getElementById("app")!;
  app.innerHTML = "";

  const header = el<HTMLDivElement>("div", "header");
  const title = el<HTMLHeadingElement>("h1");
  title.textContent = "Chronickle";
  const subtitle = el<HTMLParagraphElement>("p", "subtitle");
  subtitle.textContent = "Market volatility × news events";
  const reload = el<HTMLButtonElement>("button", "reload");
  reload.textContent = "Reload";

  const palette = el<HTMLSelectElement>("select", "palette");
  const active = rampPaletteName();
  for (const name of Object.keys(PALETTES) as PaletteName[]) {
    const opt = el<HTMLOptionElement>("option");
    opt.value = name;
    opt.textContent = name;
    if (name === active) opt.selected = true;
    palette.append(opt);
  }

  // Add-feed control: a URL input + Add button. On submit, main.ts validates
  // the URL, adds it to the FeedRegistry, fetches it once to verify and to
  // extract the real <title>, and persists.
  const feedInput = el<HTMLInputElement>("input", "feed-input");
  feedInput.type = "url";
  feedInput.placeholder = "Paste RSS feed URL…";
  feedInput.spellcheck = false;
  const feedAdd = el<HTMLButtonElement>("button", "feed-add");
  feedAdd.textContent = "Add feed";

  header.append(title, subtitle, palette, feedInput, feedAdd, reload);

  const canvasWrap = el<HTMLDivElement>("div", "canvas-wrap");
  const canvas = el<HTMLCanvasElement>("canvas", "timeline");
  canvasWrap.append(canvas);

  const tooltip = el<HTMLDivElement>("div", "tooltip hidden");
  canvasWrap.append(tooltip);

  // Feed list: one row per registered feed with a color swatch, name, and a
  // remove button. Rendered by main.ts from the FeedRegistry.
  const feedList = el<HTMLDivElement>("div", "feed-list");

  const status = el<HTMLDivElement>("div", "status");
  status.textContent = "Initializing…";

  app.append(header, feedList, canvasWrap, status);
  return { canvas, tooltip, status, reload, palette, feedInput, feedAdd, feedList };
}

function setStatus(status: HTMLDivElement, msg: string, kind: "info" | "error" = "info"): void {
  status.textContent = msg;
  status.className = `status ${kind}`;
}

function showTooltip(
  tooltip: HTMLDivElement,
  x: number,
  y: number,
  data: {
    title: string;
    link: string;
    source: string;
    color: string;
    summary: string;
    t: number;
  },
): void {
  const date = new Date(data.t).toLocaleString().replace("T", " ").slice(0, 19);
  tooltip.innerHTML = "";
  const src = el<HTMLSpanElement>("span", "tooltip-source");
  const swatch = el<HTMLSpanElement>("span", "tooltip-swatch");
  swatch.style.background = data.color;
  const srcText = document.createTextNode(`${data.source} · ${date}`);
  src.append(swatch, srcText);
  const link = el<HTMLAnchorElement>("a", "tooltip-link");
  link.href = data.link;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = data.title;
  tooltip.append(src, link);
  if (data.summary.length > 0) {
    const summary = el<HTMLParagraphElement>("p", "tooltip-summary");
    summary.textContent = data.summary;
    tooltip.append(summary);
  }
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
  tooltip.classList.remove("hidden");
}

function hideTooltip(tooltip: HTMLDivElement): void {
  tooltip.classList.add("hidden");
}

async function load(
  timeline: Timeline,
  status: HTMLDivElement,
  broker: Broker,
  updateRange: boolean = true,
): Promise<void> {
  // Markets: the broker fetches on demand via the timeline's per-frame
  // queries. We only kick the initial draw here; the broker's subscriber
  // will call timeline.reqDraw() as data arrives.
  timeline.reqDraw();
  if (updateRange) {
    // Fit to whatever the broker has cached so far (likely nothing on first
    // load). The broker's subscriber will re-fit once data lands.
    const cached = broker.cachedRange();
    if (cached) {
      timeline.setTimeRange(Range.fit(cached.min, cached.max));
    }
  }
  // Events stream in via the EventBroker's subscriber (wired in main). The
  // timeline pulls the visible slice on viewport change and on broker notify.
}

function main(): void {
  // Load saved UI state (viewport + palette) before building the app so the
  // palette select reflects the saved choice. Falls back to defaults if absent.
  const ui = loadUiState();
  if (ui.palette && ui.palette in PALETTES) {
    setRampPalette(ui.palette as PaletteName);
  }

  const { canvas, tooltip, status, reload, palette, feedInput, feedAdd, feedList } = buildApp();

  // Initial time range: saved viewport if present, else last 24h. The broker
  // will fetch this on the first query. If there's a saved viewport we skip
  // the auto-fit-on-first-data below (we respect the user's last position).
  const now = Date.now();
  const hasSavedViewport = ui.viewport !== undefined && ui.viewport.min < ui.viewport.max;
  const initial = hasSavedViewport
    ? Range.create(ui.viewport!.min, ui.viewport!.max)
    : Range.fit(now - DAY_MS, now);

  const broker = new Broker(createNobitexFetcher({ symbol: "USDTIRT" }));

  // Feeds + events: the registry persists user-added feeds to localStorage;
  // the EventBroker fetches on demand via the timeline's eventSource.
  const registry = FeedRegistry.load(DEFAULT_FEEDS);
  const eventBroker = new EventBroker({}, () => registry.active());

  const timeline = new Timeline({
    canvas,
    initialTimeRange: initial,
    dataSource: (evalTime, maxDeltaTMs) => broker.query({ evalTime, maxDeltaTMs }),
    eventSource: (range) => eventBroker.query(range),
    feedColorOf: (feedId) => registry.colorOf(feedId),
    callbacks: {
      onHover: (event) => {
        if (event === null) {
          hideTooltip(tooltip);
          return;
        }
        const feed = registry.get(event.feedId);
        showTooltip(tooltip, event.px, event.py, {
          title: event.title,
          link: event.link,
          source: feed.source,
          color: feed.color,
          summary: event.summary,
          t: event.t,
        });
      },
      onViewportChange: (viewport, priceScale) => {
        saveUiState({ viewport, palette: rampPaletteName() });
      },
    },
  });

  // When the price broker inserts new data, request a redraw. If there's no
  // saved viewport, re-fit the time range once on the first non-empty cache
  // so the viewport shows the data instead of the default 24h guess. With a
  // saved viewport we respect the user's last position and don't auto-fit.
  let fitted = hasSavedViewport;
  broker.subscribe(() => {
    timeline.reqDraw();
    if (fitted) return;

    const cached = broker.cachedRange();
    if (!cached) return;
    timeline.setTimeRange(Range.fit(cached.min, cached.max));
    fitted = true;
    setStatus(status, `Loaded data: ${cached.min}..${cached.max}`);
  });

  // When the EventBroker lands new events, request a redraw. The draw path
  // queries eventSource every frame, so the new events are picked up
  // automatically on the next rAF.
  eventBroker.subscribe(() => timeline.reqDraw());

  void load(timeline, status, broker);

  // --- Feed management UI ----------------------------------------------

  /**
   * Render the feed list from the registry. Called after any add/remove/toggle.
   * Clicking a row toggles the feed's enabled state (events show/hide);
   * the × button removes the feed from the list entirely.
   */
  function renderFeedList(): void {
    feedList.innerHTML = "";
    for (const feed of registry.all()) {
      const row = el<HTMLDivElement>("div", "feed-row");
      if (!feed.enabled) row.classList.add("disabled");
      row.title = feed.enabled ? `Click to hide ${feed.source}` : `Click to show ${feed.source}`;

      const swatch = el<HTMLSpanElement>("span", "feed-swatch");
      swatch.style.background = feed.color;
      const name = el<HTMLSpanElement>("span", "feed-name");
      name.textContent = feed.source;

      // Click anywhere on the row (except the × button) toggles enabled.
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".feed-remove")) return;
        registry.setEnabled(feed.id, !feed.enabled);
        registry.save();
        renderFeedList();
        // Force an immediate slice update + redraw so the toggle is visible
        // without waiting for the next broker fetch to notify.
        timeline.refreshEvents();
        timeline.reqDraw();
      });

      const remove = el<HTMLButtonElement>("button", "feed-remove");
      remove.textContent = "×";
      remove.title = `Remove ${feed.source}`;
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        registry.remove(feed.id);
        registry.save();
        renderFeedList();
        timeline.refreshEvents();
        timeline.reqDraw();
      });

      row.append(swatch, name, remove);
      feedList.append(row);
    }
  }
  renderFeedList();

  /**
   * Add a feed from the input. Validates the URL, adds it to the registry,
   * fetches it once to verify it parses and to extract the real <title>,
   * then persists. On failure, removes the feed and surfaces the error.
   */
  async function addFeedFromInput(): Promise<void> {
    const url = feedInput.value.trim();
    if (url.length === 0) return;

    // Basic URL validation. The input type=url already hints the browser, but
    // we re-check explicitly to fail fast on junk like "foo".
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      setStatus(status, `Invalid URL: ${url}`, "error");
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      setStatus(status, `Feed URL must be http(s): ${url}`, "error");
      return;
    }

    const feed = registry.add(url);
    registry.save();
    renderFeedList();
    feedInput.value = "";
    setStatus(status, `Verifying ${feed.source}…`);

    try {
      const parsedFeed = await fetchFeed(feed, defaultProxy, 15_000);
      // If the feed exposed a real <title>, use it as the display name.
      if (parsedFeed.title.length > 0) {
        registry.rename(feed.id, parsedFeed.title);
        registry.save();
        renderFeedList();
      }
      setStatus(status, `Added feed: ${parsedFeed.title || feed.source}`);
      // Kick the EventBroker to fetch the new feed's events for the current
      // viewport. The broker's subscriber will refreshEvents + reqDraw.
      timeline.refreshEvents();
    } catch (err) {
      // Verification failed: roll back the add and surface the error loudly.
      registry.remove(feed.id);
      registry.save();
      renderFeedList();
      setStatus(status, `Feed failed to load: ${(err as Error).message}`, "error");
    }
  }

  feedAdd.addEventListener("click", () => void addFeedFromInput());
  feedInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void addFeedFromInput();
    }
  });

  // For now, reload just re-queries; the broker cache persists. A true
  // reload would clear the broker's store (to be added).
  reload.addEventListener("click", () => timeline.reqDraw());

  palette.addEventListener("change", () => {
    // The select is populated from `Object.keys(PALETTES)`, so its value is
    // a PaletteName by construction.
    const name = palette.value as PaletteName;
    timeline.setPalette(name);
    saveUiState({ palette: name });
  });

  // Flush any debounced UI state on tab close/navigation so the last viewport
  // and palette aren't lost. Without this, a close mid-debounce would revert
  // to the previous save.
  window.addEventListener("pagehide", () =>
    flushUiState({
      viewport: { min: timeline.getTimeRange().min, max: timeline.getTimeRange().max },
      palette: rampPaletteName(),
    }),
  );
}

main();
