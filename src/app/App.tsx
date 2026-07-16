import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { EventBroker, defaultProxy, fetchFeed } from "../data/index.ts";
import { FeedRegistry } from "../data/events/feeds.ts";
import { Broker } from "../data/signal/broker.ts";
import { priceSignalSource } from "../data/signal/market/market.ts";
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
import { TimelineOverlay, type TimelineOverlayRowView } from "./components/TimelineOverlay.tsx";
import { TimelineOverlayController } from "./timeline/TimelineOverlayController.ts";
import { chartKey, chartStateKey, type ChartState } from "./chartState.ts";
import { Status, type StatusKind } from "./components/Status.tsx";
import styles from "./App.module.css";

const DAY_MS = 86_400_000;

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

  const [status, setStatusState] = createSignal<{ message: string; kind: StatusKind }>({
    message: "Initializing…",
    kind: "info",
  });
  const [feeds, setFeeds] = createSignal(registry.all());
  const [charts, setCharts] = createSignal<readonly ChartState[]>([]);
  const [viewport, setViewport] = createSignal(initialViewport);
  const [playback, setPlayback] = createSignal<TimelinePlayback>(saved.playback);
  const [newsHeight, setNewsHeight] = createSignal(saved.newsHeight);
  const [hover, setHover] = createSignal<EventTooltipModel | null>(null);
  const overlayRows = createMemo<readonly TimelineOverlayRowView[]>(() =>
    charts().map((chart) => ({
      key: chartStateKey(chart),
      sourceLabel: priceSignalSource(chart.sourceId)?.label ?? chart.sourceId,
      symbol: chart.symbol,
      palette: chart.palette,
      waveletMode: chart.waveletMode,
    })),
  );
  const timelineOverlay = new TimelineOverlayController();

  let canvas!: HTMLCanvasElement;
  let timeline: Timeline | null = null;
  let unsubscribeEvents: (() => void) | null = null;

  const setStatus = (message: string, kind: StatusKind = "info"): void => {
    setStatusState({ message, kind });
  };

  const persistedState = (): PersistedUiState => ({
    version: 3,
    viewport: viewport(),
    playback: playback(),
    newsHeight: newsHeight(),
    charts: charts().map(({ sourceId, symbol, palette, waveletMode, verticalOffset, height }) => ({
      sourceId,
      symbol,
      palette,
      waveletMode,
      verticalOffset,
      height,
    })),
  });
  const persistence = createUiStatePersistence(persistedState);

  const updateChart = (key: string, update: Partial<ChartState>): void => {
    setCharts((current) =>
      current.map((chart) => (chartStateKey(chart) === key ? { ...chart, ...update } : chart)),
    );
    persistence.schedule();
  };

  const buildTimelineRows = (): SignalRow[] =>
    charts().map((chart) => {
      const key = chartStateKey(chart);
      const broker = brokers.get(key);

      if (broker === undefined) {
        throw new Error(`Missing broker for chart ${key}`);
      }

      return {
        id: key,
        read: (request) => broker.read(request),
        readSampleAt: (time, out) => broker.readPointAtOrBefore(time, out),
        subscribe: (demand, onChange) => broker.subscribe(demand, onChange),
        palette: chart.palette,
        waveletMode: chart.waveletMode,
        verticalOffset: chart.verticalOffset,
        height: chart.height,
      };
    });

  const syncTimelineRows = (): TimelineLayout | null => {
    if (timeline === null) return null;

    timeline.setSignalRows(buildTimelineRows());
    return timeline.getLayout();
  };

  const storeTimelineLayout = (layout: TimelineLayout): void => {
    const rows = new Map(layout.rows.map((row) => [row.id, row]));
    setNewsHeight(layout.newsHeight);
    setCharts((current) =>
      current.map((chart) => {
        const layoutRow = rows.get(chartStateKey(chart));
        return layoutRow === undefined
          ? chart
          : {
              ...chart,
              height: layoutRow.height,
              verticalOffset: layoutRow.verticalOffset,
            };
      }),
    );
  };

  const disposeRemovedCharts = (removed: readonly ChartState[]): void => {
    for (const chart of removed) {
      const key = chartStateKey(chart);
      brokers.get(key)?.dispose();
      brokers.delete(key);
    }
  };

  const removedChartLabels = (removed: readonly ChartState[]): string =>
    removed
      .map((chart) => {
        const sourceLabel = priceSignalSource(chart.sourceId)?.label ?? chart.sourceId;
        return `${chart.symbol} · ${sourceLabel}`;
      })
      .join(", ");

  const removeCharts = (keys: readonly string[]): void => {
    if (keys.length === 0) return;
    const removedKeys = new Set(keys);
    let removed: ChartState[] = [];
    setCharts((current) => {
      removed = current.filter((chart) => removedKeys.has(chartStateKey(chart)));
      return removed.length === 0
        ? current
        : current.filter((chart) => !removedKeys.has(chartStateKey(chart)));
    });
    if (removed.length === 0) return;

    // Detach Timeline subscriptions while their brokers are still alive. The
    // remaining rows are reconciled by ID, so their demand and cached view stay warm.
    const fittedLayout = syncTimelineRows();
    if (fittedLayout !== null) storeTimelineLayout(fittedLayout);
    disposeRemovedCharts(removed);
    persistence.schedule();
    setStatus(`Removed ${removedChartLabels(removed)}`);
  };

  const removeChart = (key: string): void => removeCharts([key]);

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

    const key = chartKey(source.id, symbol);
    if (charts().some((chart) => chartStateKey(chart) === key)) {
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
      sourceId: source.id,
      symbol,
      palette,
      waveletMode: initial?.waveletMode ?? "centered",
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
    const fittedLayout = syncTimelineRows();
    if (fittedLayout !== null) storeTimelineLayout(fittedLayout);
    if (persist) persistence.schedule();
    setStatus(`Added ${source.label} ${symbol}`);
    return true;
  };

  const applyLayout = (layout: TimelineLayout, collapsedRowIds: readonly string[]): void => {
    const rows = new Map(layout.rows.map((row) => [row.id, row]));
    const collapsed = new Set(collapsedRowIds);
    let removed: ChartState[] = [];

    setNewsHeight(layout.newsHeight);
    setCharts((current) => {
      const next: ChartState[] = [];
      for (const chart of current) {
        const key = chartStateKey(chart);
        const layoutRow = rows.get(key);
        // A committed zero-height row is invalid even if a pointer-cancellation
        // path somehow failed to include it in collapsedRowIds.
        if (collapsed.has(key) || layoutRow?.height === 0) {
          removed.push(chart);
          continue;
        }
        next.push(
          layoutRow === undefined
            ? chart
            : {
                ...chart,
                height: layoutRow.height,
                verticalOffset: layoutRow.verticalOffset,
              },
        );
      }
      return next;
    });

    if (removed.length > 0) {
      // Reconcile first so removed subscriptions can detach cleanly and active
      // rows keep their existing subscriptions instead of flashing empty.
      const fittedLayout = syncTimelineRows();
      if (fittedLayout !== null) storeTimelineLayout(fittedLayout);
      disposeRemovedCharts(removed);
      setStatus(`Removed ${removedChartLabels(removed)}`);
    }
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

  const changeChartPalette = (key: string, palette: PaletteName): void => {
    timeline?.setSignalRowPalette(key, palette);
    updateChart(key, { palette });
  };

  const changeChartWaveletMode = (key: string, waveletMode: WaveletMode): void => {
    timeline?.setSignalRowWaveletMode(key, waveletMode);
    updateChart(key, { waveletMode });
  };

  const reloadTimelineData = (): void => {
    eventBroker.clearCache();
    for (const broker of brokers.values()) broker.clearCache();
    timeline?.refreshEvents();
    timeline?.reqDraw();
    setStatus(`Cleared signal and event caches; reloading ${charts().length} market row(s)…`);
  };

  onMount(() => {
    const range = Range.create(initialViewport.min, initialViewport.max);
    timeline = new Timeline({
      canvas,
      signalRows: buildTimelineRows(),
      initialTimeRange: range,
      initialPlayback: playback(),
      initialNewsHeight: newsHeight(),
      eventSource: (queryRange) => eventBroker.query(queryRange),
      feedColorOf: (feedId) => registry.colorOf(feedId),
      overlay: timelineOverlay,
      callbacks: {
        onHover: (event) => {
          if (event === null) {
            setHover(null);
            return;
          }

          const snapshot: HoverInfo = { ...event };
          setHover({
            event: snapshot,
            feed: registry.get(snapshot.feedId),
          });
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
      },
    });

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
    timelineOverlay.dispose();
    for (const broker of brokers.values()) broker.dispose();
    brokers.clear();
  });

  return (
    <main class={styles.app}>
      <Header />
      <div class={styles.dataControls}>
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
        onRename={(feed: RssFeed, source: string) => {
          registry.rename(feed.id, source);
          registry.save();
          setFeeds(registry.all());
          setStatus(`Renamed feed to ${source}`);
        }}
        onRemove={(feed: RssFeed) => {
          registry.remove(feed.id);
          registry.save();
          refreshFeeds();
        }}
      />
      <div class={styles.canvasWrap}>
        <canvas ref={canvas} class={styles.timeline} />
        <TimelineOverlay
          controller={timelineOverlay}
          rows={overlayRows()}
          playback={playback()}
          onTogglePlayback={() => timeline?.togglePlayback()}
          onReload={reloadTimelineData}
          onPaletteChange={changeChartPalette}
          onWaveletModeChange={changeChartWaveletMode}
          onRemoveRow={removeChart}
        />
        <EventTooltip
          controller={timelineOverlay}
          value={hover()}
          onPointerPresenceChange={(inside) => timeline?.setEventTooltipHovered(inside)}
        />
      </div>
      <Status message={status().message} kind={status().kind} />
    </main>
  );
}
