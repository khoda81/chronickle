/**
 * Chronicle entry point.
 *
 * Wires the data layer (Nobitex trades + RSS) to the canvas timeline, and
 * renders an HTML tooltip on hover. Errors are surfaced explicitly in the
 * status bar rather than swallowed.
 */

import { fetchEventSet, fetchOhlcPriceSeries } from "./data/index.ts";
import { Timeline } from "./engine/timeline.ts";
import { Range } from "./engine/range.ts";
import { PALETTES, rampPaletteName } from "./engine/ramp.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

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
} {
  const app = document.getElementById("app")!;
  app.innerHTML = "";

  const header = el<HTMLDivElement>("div", "header");
  const title = el<HTMLHeadingElement>("h1");
  title.textContent = "Chronicle";
  const subtitle = el<HTMLParagraphElement>("p", "subtitle");
  subtitle.textContent = "Market volatility × news events";
  const reload = el<HTMLButtonElement>("button", "reload");
  reload.textContent = "Reload";

  const palette = el<HTMLSelectElement>("select", "palette");
  for (const p of PALETTES) {
    const opt = el<HTMLOptionElement>("option");
    opt.value = p.name;
    opt.textContent = p.name;
    if (p.name === rampPaletteName()) opt.selected = true;
    palette.append(opt);
  }

  header.append(title, subtitle, palette, reload);

  const canvasWrap = el<HTMLDivElement>("div", "canvas-wrap");
  const canvas = el<HTMLCanvasElement>("canvas", "timeline");
  canvasWrap.append(canvas);

  const tooltip = el<HTMLDivElement>("div", "tooltip hidden");
  canvasWrap.append(tooltip);

  const status = el<HTMLDivElement>("div", "status");
  status.textContent = "Initializing…";

  app.append(header, canvasWrap, status);
  return { canvas, tooltip, status, reload, palette };
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
    t: number;
  },
): void {
  const date = new Date(data.t).toISOString().replace("T", " ").slice(0, 19);
  tooltip.innerHTML = "";
  const src = el<HTMLSpanElement>("span", "tooltip-source");
  src.textContent = `${data.source} · ${date}`;
  const link = el<HTMLAnchorElement>("a", "tooltip-link");
  link.href = data.link;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = data.title;
  tooltip.append(src, link);
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
  tooltip.classList.remove("hidden");
}

function hideTooltip(tooltip: HTMLDivElement): void {
  tooltip.classList.add("hidden");
}

async function load(timeline: Timeline, status: HTMLDivElement): Promise<void> {
  setStatus(status, "Fetching market data…");
  try {
    // OHLC gives real history (trades endpoint only returns recent trades).
    // We use only the `open` of each candle: close[k] == open[k+1].
    const now = Date.now();
    const series = await fetchOhlcPriceSeries({
      symbol: "USDTIRT",
      resolution: "1",
      fromMs: now - 180 * DAY_MS,
      toMs: now,
    });
    timeline.setSeries(series);
    const obs = series.observations;
    setStatus(status, `Loaded ${obs.length} candles. Fetching events…`);
    try {
      const events = await fetchEventSet();
      timeline.setEvents(events);
      setStatus(status, `Loaded ${obs.length} trades · ${events.events.length} events.`);
    } catch (e) {
      setStatus(status, `Events failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
    // Fit time range to the union of data ranges.
    const tMin = obs[0]?.t ?? now - DAY_MS;
    const tMax = obs[obs.length - 1]?.t ?? now;
    timeline.setTimeRange(Range.fit(tMin, tMax));
  } catch (e) {
    setStatus(status, `Market data failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

function main(): void {
  const { canvas, tooltip, status, reload, palette } = buildApp();

  // Initial time range: last 24h. Replaced after data loads.
  const now = Date.now();
  const initial = Range.fit(now - DAY_MS, now);

  const timeline = new Timeline({
    canvas,
    initialTimeRange: initial,
    callbacks: {
      onHover: (event) => {
        if (event === null) {
          hideTooltip(tooltip);
          return;
        }
        showTooltip(tooltip, event.px, event.py, event);
      },
    },
  });

  void load(timeline, status);

  reload.addEventListener("click", () => void load(timeline, status));

  palette.addEventListener("change", () => {
    timeline.setPalette(palette.value);
  });
}

main();
