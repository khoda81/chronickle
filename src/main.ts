/** Chronickle application and stacked multi-market timeline manager. */

import { EventBroker, fetchFeed, defaultProxy } from "./data/index.ts";
import { FeedRegistry } from "./data/events/feeds.ts";
import { idToColor } from "./data/events/color.ts";
import { Broker } from "./data/price/broker.ts";
import { MARKET_SOURCES, marketSource, type MarketSourceId } from "./data/price/markets.ts";
import { filterMarketSymbols, type MarketSymbol } from "./data/price/symbols.ts";
import type { RssFeed } from "./domain.ts";
import { DEFAULT_PALETTE, PALETTES, type PaletteName } from "./engine/ramp.ts";
import { Range } from "./engine/range.ts";
import { Timeline, type PriceRow } from "./engine/timeline.ts";
import type { WaveletMode } from "./engine/wavelet.ts";
import { EventTooltip } from "./ui/tooltip.ts";
import { flushUiState, loadUiState, saveUiState } from "./uiState.ts";

const DAY_MS = 86_400_000;

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

interface AppElements {
  readonly status: HTMLDivElement;
  readonly reload: HTMLButtonElement;
  readonly wavelet: HTMLSelectElement;
  readonly source: HTMLSelectElement;
  readonly symbolPicker: HTMLDivElement;
  readonly symbol: HTMLInputElement;
  readonly symbolToggle: HTMLButtonElement;
  readonly symbolMenu: HTMLDivElement;
  readonly addChart: HTMLButtonElement;
  readonly canvas: HTMLCanvasElement;
  readonly tooltip: HTMLDivElement;
  readonly feedInput: HTMLInputElement;
  readonly feedAdd: HTMLButtonElement;
  readonly feedList: HTMLDivElement;
}

interface ChartInstance {
  readonly key: string;
  readonly sourceId: MarketSourceId;
  readonly sourceLabel: string;
  readonly symbol: string;
  readonly broker: Broker;
  palette: PaletteName;
  verticalOffset: number;
}

function el<T extends HTMLElement>(tag: string, cls?: string): T {
  const element = document.createElement(tag);
  if (cls) element.className = cls;
  return element as T;
}

function buildApp(): AppElements {
  const app = document.getElementById("app")!;
  app.innerHTML = "";
  const header = el<HTMLDivElement>("div", "header");
  const title = el<HTMLHeadingElement>("h1");
  title.textContent = "Chronickle";
  const github = el<HTMLAnchorElement>("a", "github-link");
  github.href = "https://github.com/khoda81/chronickle";
  github.target = "_blank";
  github.rel = "noopener noreferrer";
  github.setAttribute("aria-label", "Open the Chronickle repository on GitHub");
  github.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.64 0 8.13c0 3.59 2.29 6.64 5.47 7.71.4.08.55-.18.55-.39 0-.19-.01-.83-.01-1.5-2.01.38-2.53-.5-2.69-.96-.09-.23-.48-.96-.82-1.15-.28-.15-.68-.53-.01-.54.63-.01 1.08.59 1.23.83.72 1.23 1.87.88 2.33.67.07-.53.28-.88.51-1.08-1.78-.21-3.64-.91-3.64-4.02 0-.89.31-1.62.82-2.19-.08-.21-.36-1.04.08-2.16 0 0 .67-.22 2.2.84A7.5 7.5 0 0 1 8 3.91c.68 0 1.36.09 2 .28 1.53-1.06 2.2-.84 2.2-.84.44 1.12.16 1.95.08 2.16.51.57.82 1.3.82 2.19 0 3.12-1.87 3.81-3.65 4.02.29.25.54.74.54 1.5 0 1.08-.01 1.95-.01 2.22 0 .21.15.47.55.39A8.14 8.14 0 0 0 16 8.13C16 3.64 12.42 0 8 0Z"/></svg><span class="github-tooltip" role="tooltip">View on GitHub</span>';
  const wavelet = el<HTMLSelectElement>("select", "wavelet-mode");
  for (const entry of [
    { value: "centered", label: "Centered growth" },
    { value: "causal", label: "Causal growth" },
  ]) {
    const option = el<HTMLOptionElement>("option");
    option.value = entry.value;
    option.textContent = entry.label;
    wavelet.append(option);
  }
  const reload = el<HTMLButtonElement>("button", "reload");
  reload.textContent = "Reload data";
  header.append(title, github, wavelet, reload);

  const marketControls = el<HTMLDivElement>("div", "market-controls");
  const source = el<HTMLSelectElement>("select", "market-source");
  for (const market of MARKET_SOURCES) {
    const option = el<HTMLOptionElement>("option");
    option.value = market.id;
    option.textContent = market.label;
    source.append(option);
  }
  const symbolPicker = el<HTMLDivElement>("div", "symbol-picker");
  const symbol = el<HTMLInputElement>("input", "market-symbol");
  symbol.setAttribute("role", "combobox");
  symbol.setAttribute("aria-autocomplete", "list");
  symbol.setAttribute("aria-expanded", "false");
  symbol.setAttribute("aria-controls", "market-symbol-menu");
  symbol.placeholder = "Ticker, e.g. BTCUSDT";
  symbol.spellcheck = false;
  const symbolToggle = el<HTMLButtonElement>("button", "symbol-toggle");
  symbolToggle.type = "button";
  symbolToggle.textContent = "▾";
  symbolToggle.title = "Show available tickers";
  symbolToggle.setAttribute("aria-label", "Show available tickers");
  const symbolMenu = el<HTMLDivElement>("div", "symbol-menu hidden");
  symbolMenu.id = "market-symbol-menu";
  symbolMenu.setAttribute("role", "listbox");
  symbolPicker.append(symbol, symbolToggle, symbolMenu);
  const addChart = el<HTMLButtonElement>("button", "chart-add");
  addChart.textContent = "Add row";
  marketControls.append(source, symbolPicker, addChart);

  const feedControls = el<HTMLDivElement>("div", "feed-controls");
  const feedInput = el<HTMLInputElement>("input", "feed-input");
  feedInput.type = "url";
  feedInput.placeholder = "Paste RSS feed URL…";
  feedInput.spellcheck = false;
  const feedAdd = el<HTMLButtonElement>("button", "feed-add");
  feedAdd.textContent = "Add feed";
  feedControls.append(feedInput, feedAdd);
  const dataControls = el<HTMLDivElement>("div", "data-controls");
  dataControls.append(marketControls, feedControls);
  const feedList = el<HTMLDivElement>("div", "feed-list");

  const wrap = el<HTMLDivElement>("div", "canvas-wrap");
  const canvas = el<HTMLCanvasElement>("canvas", "timeline");
  const tooltip = el<HTMLDivElement>("div", "tooltip hidden");
  wrap.append(canvas, tooltip);
  const status = el<HTMLDivElement>("div", "status");
  status.textContent = "Initializing…";
  app.append(header, dataControls, feedList, wrap, status);
  return {
    status,
    reload,
    wavelet,
    source,
    symbolPicker,
    symbol,
    symbolToggle,
    symbolMenu,
    addChart,
    canvas,
    tooltip,
    feedInput,
    feedAdd,
    feedList,
  };
}

function setStatus(status: HTMLDivElement, message: string, kind: "info" | "error" = "info"): void {
  status.textContent = message;
  status.className = `status ${kind}`;
}

function main(): void {
  const ui = loadUiState();
  const legacyPalette =
    ui.palette && ui.palette in PALETTES ? (ui.palette as PaletteName) : DEFAULT_PALETTE;
  const app = buildApp();
  const now = Date.now();
  let sharedRange =
    ui.viewport !== undefined && ui.viewport.min < ui.viewport.max
      ? Range.create(ui.viewport.min, ui.viewport.max)
      : Range.fit(now - DAY_MS, now);
  let waveletMode: WaveletMode = ui.waveletMode === "causal" ? "causal" : "centered";
  app.wavelet.value = waveletMode;

  const registry = FeedRegistry.load(DEFAULT_FEEDS);
  const eventBroker = new EventBroker({}, () => registry.active());
  const eventTooltip = new EventTooltip(app.tooltip);
  const charts: ChartInstance[] = [];
  const timeline = new Timeline({
    canvas: app.canvas,
    initialTimeRange: sharedRange,
    priceRows: [],
    eventSource: (range) => eventBroker.query(range),
    feedColorOf: (feedId) => registry.colorOf(feedId),
    callbacks: {
      onHover: (event) => {
        if (event === null) eventTooltip.hide();
        else eventTooltip.show(event, registry.get(event.feedId));
      },
      onViewportChange: (viewport) => {
        sharedRange = Range.create(viewport.min, viewport.max);
        saveUiState({ viewport, waveletMode });
      },
    },
  });
  timeline.setWaveletMode(waveletMode);
  eventBroker.subscribe(() => timeline.reqDraw());

  const chartSpecs = () =>
    charts.map(({ sourceId, symbol, palette, verticalOffset }) => ({
      sourceId,
      symbol,
      palette,
      verticalOffset,
    }));
  const persistCharts = () => saveUiState({ charts: chartSpecs() });

  function updatePriceRows(): void {
    const rows: PriceRow[] = charts.map((chart) => ({
      id: chart.key,
      label: `${chart.sourceLabel} · ${chart.symbol}`,
      read: (request) => chart.broker.read(request),
      subscribe: (demand, onChange) => chart.broker.subscribe(demand, onChange),
      palette: chart.palette,
      verticalOffset: chart.verticalOffset,
      onRemove: () => removeChart(chart.key),
      onPaletteChange: (palette) => {
        chart.palette = palette;
        persistCharts();
      },
      onVerticalOffsetChange: (offset) => {
        chart.verticalOffset = offset;
        persistCharts();
      },
      onDataChange: () => {
        const cached = chart.broker.cachedRange();
        if (cached !== null) {
          setStatus(
            app.status,
            `${chart.sourceLabel} ${chart.symbol} loaded through ${new Date(
              cached.max,
            ).toLocaleString()}`,
          );
        }
      },
    }));
    timeline.setPriceRows(rows);
  }

  function removeChart(key: string): void {
    const index = charts.findIndex((chart) => chart.key === key);
    if (index < 0) return;
    const [chart] = charts.splice(index, 1);
    updatePriceRows();
    chart!.broker.dispose();
    persistCharts();
    setStatus(app.status, `Removed ${chart!.sourceLabel} ${chart!.symbol}`);
  }

  function addChart(
    sourceId: string,
    rawSymbol: string,
    persist = true,
    initial?: { readonly palette?: string; readonly verticalOffset?: number },
  ): boolean {
    const source = marketSource(sourceId);
    if (source === null) {
      setStatus(app.status, `Unknown market source: ${sourceId}`, "error");
      return false;
    }
    let symbol: string;
    try {
      symbol = source.normalizeSymbol(rawSymbol);
    } catch (error) {
      setStatus(app.status, (error as Error).message, "error");
      return false;
    }
    const key = `${source.id}:${symbol}`;
    if (charts.some((chart) => chart.key === key)) {
      setStatus(app.status, `${source.label} ${symbol} is already visible`, "error");
      return false;
    }
    const broker = new Broker(source.createFetcher(symbol), {
      onError: (message, error) => {
        console.error(message, error);
        setStatus(
          app.status,
          `${source.label} ${symbol}: ${String((error as Error)?.message ?? error)}`,
          "error",
        );
      },
    });
    const paletteNames = Object.keys(PALETTES) as PaletteName[];
    const basePaletteIndex = Math.max(0, paletteNames.indexOf(legacyPalette));
    const palette =
      initial?.palette && initial.palette in PALETTES
        ? (initial.palette as PaletteName)
        : paletteNames[(basePaletteIndex + charts.length) % paletteNames.length]!;
    charts.push({
      key,
      sourceId: source.id,
      sourceLabel: source.label,
      symbol,
      broker,
      palette,
      verticalOffset:
        typeof initial?.verticalOffset === "number" && Number.isFinite(initial.verticalOffset)
          ? initial.verticalOffset
          : 0,
    });
    updatePriceRows();
    if (persist) persistCharts();
    setStatus(app.status, `Added ${source.label} ${symbol}`);
    return true;
  }

  let symbolOptions: readonly MarketSymbol[] = [];
  let highlightedSymbol = -1;
  let symbolLoadGeneration = 0;

  function closeSymbolMenu(): void {
    app.symbolMenu.classList.add("hidden");
    app.symbol.setAttribute("aria-expanded", "false");
    app.symbol.removeAttribute("aria-activedescendant");
    highlightedSymbol = -1;
  }

  function selectSymbol(option: MarketSymbol): void {
    app.symbol.value = option.symbol;
    closeSymbolMenu();
    app.symbol.focus();
  }

  function renderSymbolMenu(open = true): void {
    const matches = filterMarketSymbols(symbolOptions, app.symbol.value);
    app.symbolMenu.innerHTML = "";
    highlightedSymbol = Math.min(highlightedSymbol, matches.length - 1);
    if (matches.length === 0) {
      const empty = el<HTMLDivElement>("div", "symbol-empty");
      empty.textContent = "No listed match — you can still add the typed ticker";
      app.symbolMenu.append(empty);
    } else {
      for (let index = 0; index < matches.length; index++) {
        const option = matches[index]!;
        const row = el<HTMLButtonElement>("button", "symbol-option");
        row.type = "button";
        row.id = `market-symbol-option-${index}`;
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(index === highlightedSymbol));
        if (index === highlightedSymbol) row.classList.add("highlighted");
        const ticker = el<HTMLSpanElement>("span", "symbol-option-ticker");
        ticker.textContent = option.symbol;
        const label = el<HTMLSpanElement>("span", "symbol-option-label");
        label.textContent = option.label;
        row.append(ticker, label);
        row.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          selectSymbol(option);
        });
        app.symbolMenu.append(row);
      }
    }
    if (open) {
      app.symbolMenu.classList.remove("hidden");
      app.symbol.setAttribute("aria-expanded", "true");
      if (highlightedSymbol >= 0) {
        app.symbol.setAttribute(
          "aria-activedescendant",
          `market-symbol-option-${highlightedSymbol}`,
        );
      }
    }
  }

  async function updateSymbolSuggestions(): Promise<void> {
    const source = marketSource(app.source.value);
    if (source === null) return;
    const generation = ++symbolLoadGeneration;
    symbolOptions = source.examples;
    highlightedSymbol = -1;
    if (app.symbol.value.trim().length === 0) app.symbol.value = source.examples[0]?.symbol ?? "";
    renderSymbolMenu(false);
    try {
      const loaded = await source.loadSymbols();
      if (generation !== symbolLoadGeneration) return;
      const bySymbol = new Map<string, MarketSymbol>();
      for (const option of [...source.examples, ...loaded]) bySymbol.set(option.symbol, option);
      symbolOptions = [...bySymbol.values()];
      if (!app.symbolMenu.classList.contains("hidden")) renderSymbolMenu(true);
    } catch (error) {
      if (generation !== symbolLoadGeneration) return;
      console.warn(`${source.label} ticker discovery failed`, error);
      setStatus(
        app.status,
        `${source.label} ticker list unavailable; examples and free-form entry still work`,
      );
    }
  }

  const addSelectedChart = () => {
    if (addChart(app.source.value, app.symbol.value)) app.symbol.select();
  };
  app.source.addEventListener("change", () => {
    app.symbol.value = "";
    closeSymbolMenu();
    void updateSymbolSuggestions();
  });
  app.addChart.addEventListener("click", addSelectedChart);
  app.symbol.addEventListener("input", () => {
    highlightedSymbol = -1;
    renderSymbolMenu(true);
  });
  app.symbol.addEventListener("focus", () => renderSymbolMenu(true));
  app.symbol.addEventListener("keydown", (event) => {
    const matches = filterMarketSymbols(symbolOptions, app.symbol.value);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      highlightedSymbol =
        matches.length === 0
          ? -1
          : (highlightedSymbol + direction + matches.length) % matches.length;
      renderSymbolMenu(true);
      app.symbolMenu.querySelector(".highlighted")?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key === "Escape") {
      closeSymbolMenu();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const highlighted = matches[highlightedSymbol];
      if (highlighted !== undefined) selectSymbol(highlighted);
      else addSelectedChart();
    }
  });
  app.symbolToggle.addEventListener("click", () => {
    if (app.symbolMenu.classList.contains("hidden")) {
      app.symbol.focus();
      renderSymbolMenu(true);
    } else {
      closeSymbolMenu();
    }
  });
  app.symbolPicker.addEventListener("focusout", () => {
    queueMicrotask(() => {
      if (!app.symbolPicker.contains(document.activeElement)) closeSymbolMenu();
    });
  });
  document.addEventListener("pointerdown", (event) => {
    if (!app.symbolPicker.contains(event.target as Node)) closeSymbolMenu();
  });
  void updateSymbolSuggestions();

  const savedCharts = Array.isArray(ui.charts)
    ? ui.charts
    : [{ sourceId: "nobitex", symbol: "USDTIRT" }];
  for (const saved of savedCharts) {
    if (
      typeof saved === "object" &&
      saved !== null &&
      typeof saved.sourceId === "string" &&
      typeof saved.symbol === "string"
    ) {
      addChart(saved.sourceId, saved.symbol, false, saved);
    }
  }
  if (charts.length === 0) addChart("nobitex", "USDTIRT", false);
  persistCharts();

  function renderFeedList(): void {
    app.feedList.innerHTML = "";
    for (const feed of registry.all()) {
      const row = el<HTMLDivElement>("div", "feed-row");
      if (!feed.enabled) row.classList.add("disabled");
      row.title = feed.enabled ? `Click to hide ${feed.source}` : `Click to show ${feed.source}`;
      const swatch = el<HTMLSpanElement>("span", "feed-swatch");
      swatch.style.background = feed.color;
      const name = el<HTMLSpanElement>("span", "feed-name");
      name.textContent = feed.source;
      const remove = el<HTMLButtonElement>("button", "feed-remove");
      remove.textContent = "×";
      remove.title = `Remove ${feed.source}`;
      row.addEventListener("click", (event) => {
        if ((event.target as HTMLElement).closest(".feed-remove")) return;
        registry.setEnabled(feed.id, !feed.enabled);
        registry.save();
        renderFeedList();
        timeline.refreshEvents();
      });
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        registry.remove(feed.id);
        registry.save();
        renderFeedList();
        timeline.refreshEvents();
      });
      row.append(swatch, name, remove);
      app.feedList.append(row);
    }
  }
  renderFeedList();

  async function addFeedFromInput(): Promise<void> {
    const url = app.feedInput.value.trim();
    if (url.length === 0) return;
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")
        throw new Error("Feed URL must use HTTP or HTTPS");
    } catch (error) {
      setStatus(app.status, `Invalid feed URL: ${(error as Error).message}`, "error");
      return;
    }
    const feed = registry.add(url);
    registry.save();
    renderFeedList();
    app.feedInput.value = "";
    setStatus(app.status, `Verifying ${feed.source}…`);
    try {
      const parsed = await fetchFeed(feed, defaultProxy, 15_000);
      if (parsed.title.length > 0) registry.rename(feed.id, parsed.title);
      registry.save();
      renderFeedList();
      eventBroker.clearCache();
      timeline.refreshEvents();
      setStatus(app.status, `Added feed: ${parsed.title || feed.source}`);
    } catch (error) {
      registry.remove(feed.id);
      registry.save();
      renderFeedList();
      setStatus(app.status, `Feed failed to load: ${(error as Error).message}`, "error");
    }
  }

  app.feedAdd.addEventListener("click", () => void addFeedFromInput());
  app.feedInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void addFeedFromInput();
    }
  });
  app.reload.addEventListener("click", () => {
    eventBroker.clearCache();
    for (const chart of charts) chart.broker.clearCache();
    timeline.refreshEvents();
    timeline.reqDraw();
    setStatus(
      app.status,
      `Cleared price and event caches; reloading ${charts.length} market row(s)…`,
    );
  });
  app.wavelet.addEventListener("change", () => {
    waveletMode = app.wavelet.value as WaveletMode;
    timeline.setWaveletMode(waveletMode);
    saveUiState({ waveletMode });
  });
  window.addEventListener("pagehide", () => {
    flushUiState({
      viewport: { min: timeline.getTimeRange().min, max: timeline.getTimeRange().max },
      waveletMode,
      charts: chartSpecs(),
    });
  });
}

main();
