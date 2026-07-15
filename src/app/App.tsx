import { createSignal, onCleanup, onMount } from "solid-js";
import { EventBroker, defaultProxy, fetchFeed } from "../data/index.ts";
import { FeedRegistry } from "../data/events/feeds.ts";
import { Broker } from "../data/signal/broker.ts";
import { priceSignalSource, type PriceSignalSourceId } from "../data/signal/market/market.ts";
import type { RssFeed } from "../domain.ts";
import { DEFAULT_PALETTE, PALETTES, type PaletteName } from "../engine/ramp.ts";
import { Range } from "../engine/range.ts";
import {
  Timeline,
  type HoverInfo,
  type SignalRow,
  type TimelineLayout,
  type TimelinePlayback,
} from "../engine/timeline.ts";
import type { WaveletMode } from "../engine/wavelet.ts";
import { DEFAULT_FEEDS } from "./defaultFeeds.ts";
import {
  createUiStatePersistence,
  loadUiState,
  type PersistedChart,
  type PersistedUiState,
} from "./persistence.ts";
import { EventTooltip, type EventTooltipModel } from "./components/EventTooltip.tsx";
import { FeedInput, FeedList } from "./components/FeedControls.tsx";
import { Header } from "./components/Header.tsx";
import { MarketControls } from "./components/MarketControls.tsx";

const DAY_MS = 86_400_000;

interface ChartState {
  readonly key: string;
  readonly sourceId: PriceSignalSourceId;
  readonly sourceLabel: string;
  readonly symbol: string;
  readonly palette: PaletteName;
  readonly verticalOffset: number;
  readonly height?: number;
}

interface StatusState {
  readonly message: string;
  readonly kind: "info" | "error";
}

export function App() {
  const saved = loadUiState();
  const now = Date.now();
  const initialViewport: { readonly min: number; readonly max: number } = saved.viewport ?? {
    min: now - DAY_MS,
    max: now,
  };
  const registry = FeedRegistry.load(DEFAULT_FEEDS);
  const eventBroker = new EventBroker({}, () => registry.active());
  const brokers = new Map<string, Broker>();

  const [status, setStatusState] = createSignal<StatusState>({
    message: "Initializing…",
    kind: "info",
  });
  const [feeds, setFeeds] = createSignal(registry.all());
  const [charts, setCharts] = createSignal<readonly ChartState[]>([]);
  const [viewport, setViewport] = createSignal(initialViewport);
  const [waveletMode, setWaveletModeState] = createSignal<WaveletMode>(saved.waveletMode);
  const [playback, setPlayback] = createSignal<TimelinePlayback>(saved.playback);
  const [newsHeight, setNewsHeight] = createSignal(saved.newsHeight);
  const [hover, setHover] = createSignal<EventTooltipModel | null>(null);

  let canvas!: HTMLCanvasElement;
  let timeline: Timeline | null = null;
  let unsubscribeEvents: (() => void) | null = null;

  const setStatus = (message: string, kind: "info" | "error" = "info"): void => {
    setStatusState({ message, kind });
  };

  const persistedState = (): PersistedUiState => ({
    version: 2,
    viewport: viewport(),
    waveletMode: waveletMode(),
    playback: playback(),
    newsHeight: newsHeight(),
    charts: charts().map(({ sourceId, symbol, palette, verticalOffset, height }) => ({
      sourceId,
      symbol,
      palette,
      verticalOffset,
      height,
    })),
  });
  const persistence = createUiStatePersistence(persistedState);

  const updateChart = (key: string, update: Partial<ChartState>): void => {
    setCharts((current) =>
      current.map((chart) => (chart.key === key ? { ...chart, ...update } : chart)),
    );
    persistence.schedule();
  };

  const syncTimelineRows = (): void => {
    if (timeline === null) return;
    const rows: SignalRow[] = charts().map((chart) => {
      const broker = brokers.get(chart.key);
      if (broker === undefined) throw new Error(`Missing broker for chart ${chart.key}`);
      return {
        id: chart.key,
        label: `${chart.sourceLabel} · ${chart.symbol}`,
        read: (request) => broker.read(request),
        readSampleAt: (time, out) => broker.readPointAtOrBefore(time, out),
        subscribe: (demand, onChange) => broker.subscribe(demand, onChange),
        palette: chart.palette,
        verticalOffset: chart.verticalOffset,
        height: chart.height,
        onRemove: () => removeChart(chart.key),
        onPaletteChange: (palette) => updateChart(chart.key, { palette }),
        onVerticalOffsetChange: (verticalOffset) => updateChart(chart.key, { verticalOffset }),
        onDataChange: () => {
          const cached = broker.cachedRange();
          if (cached === null) return;
          setStatus(
            `${chart.sourceLabel} ${chart.symbol} loaded through ${new Date(cached.max).toLocaleString()}`,
          );
        },
      };
    });
    timeline.setSignalRows(rows);
  };

  const removeChart = (key: string): void => {
    const chart = charts().find((candidate) => candidate.key === key);
    if (chart === undefined) return;
    setCharts((current) => current.filter((candidate) => candidate.key !== key));
    syncTimelineRows();
    brokers.get(key)?.dispose();
    brokers.delete(key);
    persistence.schedule();
    setStatus(`Removed ${chart.sourceLabel} ${chart.symbol}`);
  };

  const addChart = (
    sourceId: string,
    rawSymbol: string,
    persist = true,
    initial?: PersistedChart,
  ): boolean => {
    const source = priceSignalSource(sourceId);
    if (source === null) {
      setStatus(`Unknown market source: ${sourceId}`, "error");
      return false;
    }

    let symbol: string;
    try {
      symbol = source.normalizeSymbol(rawSymbol);
    } catch (error) {
      setStatus((error as Error).message, "error");
      return false;
    }

    const key = `${source.id}:${symbol}`;
    if (charts().some((chart) => chart.key === key)) {
      setStatus(`${source.label} ${symbol} is already visible`, "error");
      return false;
    }

    const broker = new Broker(source.createAdapter(symbol), {
      onError: (message, error) => {
        console.error(message, error);
        setStatus(
          `${source.label} ${symbol}: ${String((error as Error | undefined)?.message ?? error)}`,
          "error",
        );
      },
    });
    const paletteNames = Object.keys(PALETTES) as PaletteName[];
    const requestedPalette = initial?.palette;
    const defaultPaletteIndex = Math.max(0, paletteNames.indexOf(DEFAULT_PALETTE));
    const palette =
      requestedPalette !== undefined && requestedPalette in PALETTES
        ? requestedPalette
        : (paletteNames[(defaultPaletteIndex + charts().length) % paletteNames.length] ??
          DEFAULT_PALETTE);
    const chart: ChartState = {
      key,
      sourceId: source.id,
      sourceLabel: source.label,
      symbol,
      palette,
      verticalOffset:
        initial?.verticalOffset !== undefined && Number.isFinite(initial.verticalOffset)
          ? initial.verticalOffset
          : 0,
      height:
        initial?.height !== undefined && Number.isFinite(initial.height) && initial.height > 0
          ? initial.height
          : undefined,
    };
    brokers.set(key, broker);
    setCharts((current) => [...current, chart]);
    syncTimelineRows();
    if (persist) persistence.schedule();
    setStatus(`Added ${source.label} ${symbol}`);
    return true;
  };

  const applyLayout = (layout: TimelineLayout): void => {
    const heights = new Map(layout.rows.map((row) => [row.id, row.height]));
    setNewsHeight(layout.newsHeight);
    setCharts((current) =>
      current.map((chart) => ({ ...chart, height: heights.get(chart.key) ?? chart.height })),
    );
    persistence.schedule();
  };

  const refreshFeeds = (): void => {
    setFeeds(registry.all());
    timeline?.refreshEvents();
  };

  const addFeed = async (url: string): Promise<boolean> => {
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error("Feed URL must use HTTP or HTTPS");
      }
    } catch (error) {
      setStatus(`Invalid feed URL: ${(error as Error).message}`, "error");
      return false;
    }

    const sizeBefore = registry.size;
    const feed = registry.add(url);
    if (registry.size === sizeBefore) {
      setStatus(`${feed.source} is already registered`, "error");
      return false;
    }
    registry.save();
    refreshFeeds();
    setStatus(`Verifying ${feed.source}…`);
    try {
      const parsed = await fetchFeed(feed, defaultProxy, 15_000);
      if (parsed.title.length > 0) registry.rename(feed.id, parsed.title);
      registry.save();
      setFeeds(registry.all());
      eventBroker.clearCache();
      timeline?.refreshEvents();
      setStatus(`Added feed: ${parsed.title || feed.source}`);
      return true;
    } catch (error) {
      registry.remove(feed.id);
      registry.save();
      refreshFeeds();
      setStatus(`Feed failed to load: ${(error as Error).message}`, "error");
      return false;
    }
  };

  for (const chart of saved.charts.length > 0
    ? saved.charts
    : [{ sourceId: "nobitex", symbol: "USDTIRT" }]) {
    addChart(chart.sourceId, chart.symbol, false, chart);
  }
  if (charts().length === 0) addChart("nobitex", "USDTIRT", false);

  onMount(() => {
    const range = Range.create(initialViewport.min, initialViewport.max);
    timeline = new Timeline({
      canvas,
      initialTimeRange: range,
      initialPlayback: playback(),
      initialNewsHeight: newsHeight(),
      eventSource: (queryRange) => eventBroker.query(queryRange),
      feedColorOf: (feedId) => registry.colorOf(feedId),
      callbacks: {
        onHover: (event) => {
          if (event === null) {
            setHover(null);
            return;
          }
          const snapshot: HoverInfo = { ...event };
          setHover({ event: snapshot, feed: registry.get(snapshot.feedId) });
        },
        onViewportChange: (nextViewport) => {
          setViewport(nextViewport);
          persistence.schedule();
        },
        onPlaybackChange: (nextPlayback) => {
          setPlayback(nextPlayback);
          persistence.schedule();
        },
        onLayoutChange: applyLayout,
        onReload: () => {
          eventBroker.clearCache();
          for (const broker of brokers.values()) broker.clearCache();
          timeline?.refreshEvents();
          timeline?.reqDraw();
          setStatus(`Cleared signal and event caches; reloading ${charts().length} market row(s)…`);
        },
      },
    });
    timeline.setWaveletMode(waveletMode());
    syncTimelineRows();
    unsubscribeEvents = eventBroker.subscribe(() => timeline?.reqDraw());

    const onPageHide = (): void => persistence.flush();
    window.addEventListener("pagehide", onPageHide);
    onCleanup(() => window.removeEventListener("pagehide", onPageHide));
  });

  onCleanup(() => {
    persistence.flush();
    persistence.dispose();
    unsubscribeEvents?.();
    timeline?.dispose();
    for (const broker of brokers.values()) broker.dispose();
    brokers.clear();
  });

  const changeWaveletMode = (mode: WaveletMode): void => {
    setWaveletModeState(mode);
    timeline?.setWaveletMode(mode);
    persistence.schedule();
  };

  return (
    <>
      <Header waveletMode={waveletMode()} onWaveletModeChange={changeWaveletMode} />
      <div class="data-controls">
        <MarketControls
          onAdd={(sourceId, symbol) => addChart(sourceId, symbol)}
          onLoadError={(message) => setStatus(message)}
        />
        <FeedInput onAdd={addFeed} />
      </div>
      <FeedList
        feeds={feeds()}
        onToggle={(feed: RssFeed) => {
          registry.setEnabled(feed.id, !feed.enabled);
          registry.save();
          refreshFeeds();
        }}
        onRemove={(feed: RssFeed) => {
          registry.remove(feed.id);
          registry.save();
          refreshFeeds();
        }}
      />
      <div class="canvas-wrap">
        <canvas ref={canvas} class="timeline" />
        <EventTooltip value={hover()} />
      </div>
      <div class={`status ${status().kind}`}>{status().message}</div>
    </>
  );
}
