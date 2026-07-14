# chronickle

![Screenshot of the app](./assets/screenshot.png)
Browser-based SPA that correlates multi-source market growth with real-world news events on a scrubbable timeline.

Live: **<https://khoda81.github.io/chronickle/>**

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

Each market row owns a price broker, while one timeline stacks a resizable news row above all price heatmaps and draws a single shared time axis between them. Reload increments broker generations, clears price/event caches, and ignores responses from requests that began before the reload.

The market picker loads active Binance and Nobitex symbols into a filterable autocomplete while preserving free-form entry. Yahoo Finance supports futures and other symbols, including `CL=F` (WTI crude) and `BZ=F` (Brent crude).
