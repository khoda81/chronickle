# Signal data model

This directory is deliberately independent of prices and exchanges. It caches
samples of a real-valued signal and coordinates acquisition for the current UI
interest. `market/` is one concrete family of sources: it validates positive
prices and converts them to log-price samples before crossing this boundary.

## Roles

- `Broker` owns subscriptions, cached reconstruction spans, settled-search
  diagnostics, and pure reads for the renderer.
- `SignalAdapter` owns acquisition policy: native sample-period selection,
  request expansion, deduplication, cancellation, retry/backoff, and live
  transport lifetime.
- `RangeLoader` is the adapter's low-level range fetch operation. It knows the
  exchange/API wire format but not the broker or renderer.
- `SignalSpanStore` retains the finest reconstruction evidence for each cached
  interval and evaluates the signal on the renderer's time grid.

## Core contracts

1. A `Sample` is one observation `{ t, value }`. Both fields are finite and `t`
   is epoch milliseconds. A batch is normalized to strictly increasing `t`;
   duplicate timestamps are last-write-wins.
2. Samples say nothing by themselves about unobserved instants. The current
   renderer uses zero-order-hold reconstruction. `SignalSpan` is that derived
   reconstruction plus source cadence, not a claim of continuous observation.
3. Smaller sample periods are finer. Fine cached or settled evidence satisfies
   a coarser demand; coarse evidence never satisfies a finer demand.
4. All coverage ranges are half-open `[min, max)`. Touching ranges may merge;
   no millisecond adjacency tolerance is used.
5. A broker demand means “make at least this range available with sample
   spacing no larger than this.” It is not a literal HTTP request. An adapter
   may fetch and deliver a wider range, and the broker caches all valid samples
   in the delivered `searchedRange`.
6. `setDemands` replaces the session's complete interest snapshot. The adapter
   may keep a live transport warm after live interest disappears, but must not
   multiply work when the viewport moves.
7. A delivery reports the range actually searched. Empty results still settle
   that searched range. Partial API responses report only the part searched so
   the remaining gap can be scheduled later.
8. Reads are side-effect-free. Only subscriptions change acquisition demand.
9. Visible future time has no samples and is presented as `pending` or
   `watching`. A demand containing the adapter's current clock is live demand.
10. `sampleRevision` changes only when cached values can change (ingestion or
    clear). Pending/watching/failure changes notify subscribers but do not
    invalidate the heatmap's numerical cache.
11. Clearing or disposing a session aborts in-flight work. Results from stale
    work must never be delivered after the generation/session is gone.

## Market boundary

`market/price.ts` is the only shared price-to-signal conversion boundary.
Market adapters parse `PricePoint`, reject non-finite or non-positive prices,
apply the natural logarithm, and emit generic `Sample` values. The broker,
store, wavelet code, and coverage logic never import a price type.
