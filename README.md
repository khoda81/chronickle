# chronickle

Browser-based SPA that correlates multi-source market growth with real-world news events on a scrubbable HTML5 `<canvas>` timeline.

Live: **https://khoda81.github.io/chronickle/**

## Tech Stack

- **Language:** TypeScript (strict, `noUncheckedIndexedAccess`)
- **Runtime/Bundler:** Bun + Vite
- **UI:** Vanilla TS + DOM. No charting libraries. Custom `<canvas>` renderer.

## Develop

```sh
bun install
bun run dev        # vite dev server (HMR)
bun run test       # numerical and data-structure invariants
bun run build      # tsc -b && vite build -> dist/
bun run typecheck  # tsc --noEmit
bun run preview    # serve dist/ locally
```

## Architecture

```
src/
  domain.ts            # Shared immutable types: HeatSample, HeatSeries, NewsEvent, EventSet
  uiState.ts           # Persistent viewport, palette, wavelet, and chart selections
  data/
    price/             # Evidence-backed broker plus Nobitex/Binance adapters
    events/            # RSS parsing, archive walking, and event broker
    index.ts           # Re-exports
  engine/
    wavelet.ts         # Centered Gaussian and causal multi-scale transforms
    gfx/               # Canvas layers: heatmap, coverage, events, and axis
    timeline.ts        # Stacked, resizable news/price timeline controller
  main.ts              # Market-row manager, source/ticker UI, feeds, and reload
  styles.css           # App styles
```

Each market row owns a price broker, while one timeline stacks a resizable news row above all price heatmaps and draws a single shared time axis between them. Reload increments broker generations, clears price/event caches, and ignores responses from requests that began before the reload.
