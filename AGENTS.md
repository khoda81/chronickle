# Chronickle

Browser-based SPA that correlates market volatility (Nobitex USD/IRT trades) with real-world news events (RSS) on a scrubbable, zoomable HTML5 `<canvas>` timeline.

## Tech Stack

- **Language:** TypeScript (strict, `noUncheckedIndexedAccess`)
- **Runtime/Bundler:** Bun + Vite
- **VCS:** jj (commit frequently, set description after every change)
- **UI:** Vanilla TS + DOM. No charting libraries. Custom `<canvas>` renderer.

## Commands

```sh
bun install          # install deps
bun run dev          # vite dev server (HMR)
bun run test         # numerical and data-structure invariants
bun run build        # tsc -b && vite build -> dist/
bun run typecheck    # tsc --noEmit  (run after edits)
```

Always run `bun run test` and `bun run typecheck` after non-trivial edits. The project must stay type-clean.

## Architecture

```
src/
  domain.ts            # Shared immutable types: HeatSample, HeatSeries, NewsEvent, EventSet
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

### Data flow

`main.ts` fetches `HeatSeries` + `EventSet`, pushes them into `Timeline` via `setSeries`/`setEvents`, and fits the viewport to the data range. The `Timeline` owns the render loop and input; the renderer is a pure function of `(viewport, series, events, size, hover)`.

### External APIs

- **Nobitex trades:** `GET https://apiv2.nobitex.ir/v2/trades/{symbol}` — public, no auth, returns recent trades only (no historical pagination). Response: `{ status, trades: [{ time, price, volume, type }] }` with `time` in epoch ms.
- **Nobitex OHLC** (not yet used, available for longer history): `GET https://apiv2.nobitex.ir/market/udf/history?symbol=USDTIRT&resolution=D&from=...&to=...` — returns `{ s, t[], o[], h[], l[], c[], v[] }` with times in epoch seconds.
- **Nobitex websocket:** `wss://ws.nobitex.ir/connection/websocket` (Centrifugo). Public channels: `public:trades-{SYMBOL}`, `public:candle-{SYMBOL}-{resolution}`, `public:orderbook-{SYMBOL}`. No auth needed for public channels.
- **RSS:** routed through `https://corsproxy.io/?url=` because browser CORS blocks direct fetch. Parsed with `DOMParser` as `application/xml`.

API docs: https://apidocs.nobitex.ir/

## Architectural Directives (CRITICAL)

These override default "minimal diff" guidance. Optimize for minimal elegant code, not small diffs.

### 1. Make Invalid States Unrepresentable

- Design data over logic. Prefer algebraic data types over flag fields.
- Enforce invariants structurally (e.g. `Viewport.create` throws on `tStart >= tEnd`; `HeatSeries` precomputes `maxDI`).
- Derive data rather than storing redundant state.

### 2. Fail Fast & Explicitly

- No blanket `try/catch` to suppress errors or return defaults.
- Throw loud, explicit errors on invalid state. Surface failures to the user (see `status` bar in `main.ts`).

### 3. Structural Integrity > Minimal Diff

- If a bug stems from a poorly designed data structure, refactor the data structure.
- No surface-level patches or band-aids.

### 4. Minimal Mutation & Elegant State

- Keep state model small. Replace state wholesale (immutable updates) rather than mutating fields.
- Prefer pure functions. The renderer is a pure function of its inputs; `Timeline.state` is replaced, not mutated.

### 5. GC Discipline in the Render Loop

- The hot path (`render`, pan/zoom handlers) must not allocate.
- Reuse module-level scratch buffers (see `rampPixels` LUT in `renderer.ts`).
- Avoid per-frame object creation in `requestAnimationFrame`.

### 6. VCS (jj)

- Commit frequently. Set the change description after every change.
- `node_modules/` and `dist/` are gitignored. If jj snapshotted them before `.gitignore` existed, untrack with `jj file untrack`.
- Use `EDITOR=true jj squash --from <src> --into <dst>` to move changes between commits without opening an editor.

## Conventions

- Timestamps are epoch milliseconds everywhere internally. Nobitex OHLC returns seconds — convert on ingestion.
- All `readonly` fields on domain types. Arrays exposed as `readonly T[]`.
- Strict null checks everywhere; `noUncheckedIndexedAccess` is on, so indexed access yields `T | undefined` — handle it.
- Canvas uses device-pixel-ratio scaling (`ctx.setTransform(dpr, ...)`); all layout constants in `renderer.ts` are CSS pixels.
- Color ramp for the heatmap is a precomputed 256-entry LUT built once from a gradient.
