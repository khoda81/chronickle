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

## Deployment

Releases are published automatically to GitHub Pages via the workflow in
`.github/workflows/deploy.yml`. On every **release published** event, the
workflow builds `dist/` and pushes it into the `gh-pages` branch of
[`khoda81/khoda81.github.io`](https://github.com/khoda81/khoda81.github.io)
under the `chronickle/` subdirectory, where it is served at
<https://khoda81.github.io/chronickle/>.

### One-time setup

The workflow pushes to a *different* repository, so the default `GITHUB_TOKEN`
is not enough. Create a fine-grained **Personal Access Token** with
`Contents: Read & Write` permission on `khoda81/khoda81.github.io`, then add it
as a repository secret in this repo:

- **Settings → Secrets and variables → Actions → New repository secret**
- Name: `PAGES_DEPLOY_TOKEN`
- Value: the PAT above

The `vite.config.ts` sets `base: "/chronickle/"` so hashed assets resolve under
the `/chronickle/` path on Pages.

## External APIs

- **Nobitex trades:** `GET https://apiv2.nobitex.ir/v2/trades/{symbol}` — public, no auth, returns recent trades only (no historical pagination). Response: `{ status, trades: [{ time, price, volume, type }] }` with `time` in epoch ms.
- **Nobitex OHLC:** `GET https://apiv2.nobitex.ir/market/udf/history?symbol=USDTIRT&resolution=D&from=...&to=...` — `{ s, t[], o[], h[], l[], c[], v[] }` with times in epoch seconds.
- **Nobitex websocket:** `wss://ws.nobitex.ir/connection/websocket` (Centrifugo). Public channels: `public:trades-{SYMBOL}`, `public:candle-{SYMBOL}-{resolution}`, `public:orderbook-{SYMBOL}`.
- **RSS:** routed through `https://corsproxy.io/?url=` because browser CORS blocks direct fetch. Parsed with `DOMParser` as `application/xml`.

API docs: https://apidocs.nobitex.ir/
