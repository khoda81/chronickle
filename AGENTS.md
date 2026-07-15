# Chronickle

Browser-based SPA that correlates market volatility (Nobitex USD/IRT trades) with real-world news events (RSS) on a scrubbable, zoomable HTML5 `<canvas>` timeline.

## Tech Stack

- **Language:** TypeScript (strict, `noUncheckedIndexedAccess`)
- **Runtime/Bundler:** Bun + Vite
- **VCS:** jj (commit frequently, set description after every change)
- **UI:** SolidJS for application UI and persisted state. No charting libraries. Custom `<canvas>` renderer.

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
  app/
    App.tsx              # Solid composition root and application actions
    persistence.ts       # Versioned, debounced localStorage snapshot
    components/          # Declarative controls, accessible UI primitives, and timeline overlay DOM
    timeline/            # Imperative DOM adapter for canvas-owned overlay geometry
  data/
    events/              # Feed registry, RSS loading, and event broker
    signal/              # Generic signal broker/store and market adapters
  engine/
    timeline.ts          # Canvas controller: rAF, gestures, subscriptions, overlays
    plot.ts              # Canvas/frame lifecycle
    gfx/                 # Immediate-mode drawing primitives
  styles/
    tokens.css            # Design tokens: typography, spacing, color, shape, and motion
    reset.css             # Element normalization only
    global.css            # Document-level appearance only
  main.tsx               # Solid mount only
```

### Ownership boundary

Solid owns the DOM outside the timeline engine and all serializable application state. `Timeline` owns the canvas, pointer/gesture runtime, render scheduling, scratch buffers, and broker subscriptions. Do not put per-frame values or pointer coordinates in Solid signals merely to make them reactive.

Solid creates and destroys timeline overlay nodes. `TimelineOverlayController` is a DOM rendering adapter, not application state: `Timeline` communicates with it only through the primitive `TimelineOverlaySink` contract so crosshairs and tooltip geometry stay off the reactive hot path.

The application persists one versioned snapshot containing viewport, wavelet mode, playback mode, news height, and per-row palette/offset/height. Runtime resources such as brokers, subscriptions, observers, timers, DOM refs, and typed-array scratch storage are never serialized.

Canvas redraw invalidation remains explicit and coalesced through `Timeline.reqDraw()`. A framework effect must not call the renderer for every reactive dependency.

General application dimensions belong in CSS design tokens and use relative units.
Canvas-coupled overlay geometry lives in `ui/timelineOverlayMetrics.ts`; Solid
exposes those pixel metrics to CSS as custom properties so renderer measurements
and DOM dimensions have one source of truth. Do not duplicate those values in a
component stylesheet.

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
- Throw loud, explicit errors on invalid state. Surface failures to the user through the status bar in `app/App.tsx`.

### 3. Structural Integrity > Minimal Diff

- If a bug stems from a poorly designed data structure, refactor the data structure.
- No surface-level patches or band-aids.

### 4. Minimal Mutation & Elegant State

- Keep state model small. Replace state wholesale (immutable updates) rather than mutating fields.
- Prefer pure functions at domain and rendering boundaries. Local mutation is acceptable for controller-owned hot-path state and reusable scratch storage.

### 5. GC Discipline in the Render Loop

- The hot path (`render`, pan/zoom handlers) must not allocate.
- Reuse controller- or module-owned scratch buffers and precomputed lookup tables.
- Avoid per-frame object creation in `requestAnimationFrame`.

### 6. VCS (jj)

- Commit frequently. Set the change description after every change.
- `node_modules/` and `dist/` are gitignored. If jj snapshotted them before `.gitignore` existed, untrack with `jj file untrack`.
- Use `EDITOR=true jj squash --from <src> --into <dst>` to move changes between commits without opening an editor.

## Conventions

- Timestamps are epoch milliseconds everywhere internally. Nobitex OHLC returns seconds — convert on ingestion.
- All `readonly` fields on domain types. Arrays exposed as `readonly T[]`.
- Strict null checks everywhere; `noUncheckedIndexedAccess` is on, so indexed access yields `T | undefined` — handle it.
- Canvas uses device-pixel-ratio scaling (`ctx.setTransform(dpr, ...)`); all layout constants in the canvas engine are CSS pixels.
- Color ramp for the heatmap is a precomputed 256-entry LUT built once from a gradient.
