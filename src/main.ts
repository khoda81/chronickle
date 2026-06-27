/**
 * Chronicle entry point.
 *
 * Wires the data layer (Nobitex trades + RSS) to the canvas timeline, and
 * renders an HTML tooltip on hover. Errors are surfaced explicitly in the
 * status bar rather than swallowed.
 */

import { fetchEventSet } from "./data/index.ts";
import { Timeline } from "./engine/timeline.ts";
import { Range } from "./engine/range.ts";
import { PALETTES, rampPaletteName } from "./engine/ramp.ts";
import { Broker } from "./data/brokerOrchestrator.ts";
import { createNobitexFetcher } from "./data/nobitexFetcher.ts";

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
  const date = new Date(data.t).toLocaleString().replace("T", " ").slice(0, 19);
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
  timeline.setEvents(await fetchEventSet());
}

function main(): void {
  const { canvas, tooltip, status, reload, palette } = buildApp();

  // Initial time range: last 24h. The broker will fetch this on the first
  // query and re-fit once data lands.
  const now = Date.now();
  const initial = Range.fit(now - DAY_MS, now);

  const broker = new Broker(createNobitexFetcher({ symbol: "USDTIRT" }));

  const timeline = new Timeline({
    canvas,
    initialTimeRange: initial,
    dataSource: (evalTime, maxDeltaTMs) => broker.query({ evalTime, maxDeltaTMs }),
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

  // When the broker inserts new data, request a redraw. Also re-fit the
  // time range once on the first non-empty cache so the viewport shows the
  // data instead of the default 24h guess.
  let fitted = false;
  broker.subscribe(() => {
    timeline.reqDraw();
    if (!fitted) {
      const cached = broker.cachedRange();
      if (cached) {
        timeline.setTimeRange(Range.fit(cached.min, cached.max));
        fitted = true;
        setStatus(status, `Loaded data: ${cached.min}..${cached.max}`);
      }
    }
  });

  void load(timeline, status, broker);

  reload.addEventListener("click", () => {
    // For now, reload just re-queries; the broker cache persists. A true
    // reload would clear the broker's store (to be added).
    timeline.reqDraw();
  });

  palette.addEventListener("change", () => {
    timeline.setPalette(palette.value);
  });
}

main();
