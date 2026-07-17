# Signal data model

This directory is deliberately independent of prices and exchanges. It caches
samples of a real-valued signal and coordinates acquisition for the current UI
interest. `market/` is one concrete family of sources: it validates positive
prices and converts them to log-price samples before crossing this boundary.

## Roles

- `Broker` owns subscriptions, cached reconstruction segments, request
  diagnostics, and pure reads for the renderer.
- `SignalAdapter` owns acquisition policy: native sample-period selection,
  request expansion, deduplication, cancellation, retry/backoff, and live
  transport lifetime.
- `IntervalLoader` is the adapter's low-level range fetch operation. It knows the
  exchange/API wire format but not the broker or renderer.
- `SignalSegmentStore` retains the finest reconstruction evidence for each cached
  interval and evaluates both its values and selected observation identities on
  the renderer's device-pixel grid.

## Core contracts

1. A `Sample` is one observation `{ t, value }`. Both fields are finite and `t`
   is epoch milliseconds. A batch is normalized to strictly increasing `t`;
   duplicate timestamps are last-write-wins.
2. Samples say nothing by themselves about unobserved instants. The current
   renderer uses zero-order-hold reconstruction. `HeldSignalSegment` is that
   derived reconstruction: one observation held over a half-open range plus its
   source cadence, not a claim of continuous observation.
3. Smaller sample periods are finer. Fine adapter search evidence satisfies a
   coarser demand; coarse evidence never satisfies a finer demand.
4. All coverage intervals are half-open `[start, end)`. Touching ranges may merge;
   no millisecond adjacency tolerance is used.
5. A broker demand means “make at least this range available with sample
   spacing no larger than this.” It is not a literal HTTP request. An adapter
   may fetch and deliver a wider range, and the broker caches all valid samples
   in the delivered `searchedInterval`.
6. `setDemands` replaces the session's complete interest snapshot. The adapter
   may keep a live transport warm after live interest disappears, but must not
   multiply work when the viewport moves.
7. A delivery reports the range actually searched and the cadence of its
   returned samples. These may differ: a source can exhaust a fine search but
   return a coarser retained fallback, which the broker must cache at its actual
   quality. Empty results settle a range only when the adapter considers them
   authoritative. Partial responses report only the part searched so the
   remaining gap can be scheduled later.
8. Reads are side-effect-free. Only subscriptions change acquisition demand.
9. Status diagnostics have two explicit layers. The broker returns the selected
   observation identity beside every reconstructed value. The wavelet input
   pipeline reports one when that identity advances and zero for a hold or
   missing value, so the bar can never describe cached evidence the heatmap did
   not use. Request status is `pending` or `retrying`; serialized gaps waiting
   behind active work remain visible. The adapter privately distinguishes queued
   from executing work to serialize I/O, but both mean `pending` from the
   broker's point of view.
10. The broker has no clock or evaluation horizon. It accepts every observation
    inside an adapter's declared searched range and may select it for any read.
    The adapter alone projects the future part of demand as `pending`, schedules
    its transition into fetchable history, and manages any internal live lease.
11. `sampleRevision` changes only when the selected reconstruction can change
    (ingestion or clear). Pending/retry changes notify subscribers but do not
    invalidate the heatmap's numerical cache.
12. Clearing or disposing a session aborts in-flight work. Results from stale
    work must never be delivered after the generation/session is gone.

## Market boundary

`market/price.ts` is the only shared price-to-signal conversion boundary.
Market adapters parse `PricePoint`, reject non-finite or non-positive prices,
apply the natural logarithm, and emit generic `Sample` values. The broker,
store, wavelet code, and request-status logic never import a price type.
