# chronickle

Browser-based SPA that correlates market volatility (Nobitex USD/IRT trades) with real-world news events (RSS) on a scrubbable, zoomable HTML5 `<canvas>` timeline.

Live: **https://khoda81.github.io/chronickle/**

## Tech Stack

- **Language:** TypeScript (strict, `noUncheckedIndexedAccess`)
- **Runtime/Bundler:** Bun + Vite
- **UI:** Vanilla TS + DOM. No charting libraries. Custom `<canvas>` renderer.

## Develop

```sh
bun install
bun run dev        # vite dev server (HMR)
bun run build      # tsc -b && vite build -> dist/
bun run typecheck  # tsc --noEmit
bun run preview    # serve dist/ locally
```

## Architecture

```
src/
  domain.ts            # Shared immutable types: HeatSample, HeatSeries, NewsEvent, EventSet
  uiState.ts           # UI state (tooltip, status bar)
  data/
    nobitex.ts         # Fetch /v2/trades/{symbol}, resample to uniform dt, compute |log-return|
    rss.ts             # Fetch RSS via CORS proxy, parse XML, normalize to sorted EventSet
    index.ts           # Re-exports
  engine/
    viewport.ts        # Pure Viewport (pan/zoom/fit) + timeToX/xToTime
    renderer.ts        # Pure canvas renderer: heatmap + event nodes + axis + hit-test
    timeline.ts        # Timeline class: rAF loop, pointer/wheel handlers, hover/click
  main.ts              # App entry: wires data -> timeline, tooltip UI, status bar
  styles.css           # App styles
```

`main.ts` fetches `HeatSeries` + `EventSet`, pushes them into `Timeline` via `setSeries`/`setEvents`, and fits the viewport to the data range. The `Timeline` owns the render loop and input; the renderer is a pure function of `(viewport, series, events, size, hover)`.
