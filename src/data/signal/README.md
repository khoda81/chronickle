# Signal data model

This directory is deliberately independent of prices and exchanges. It caches
samples of a real-valued signal and coordinates acquisition for the current UI
interest. `market/` is one concrete family of sources: it validates positive
prices and converts them to log-price samples before crossing this boundary.

## Roles

- `Broker` owns subscriptions, the cached numeric series, request diagnostics,
  and pure reads for the renderer.
- `SignalAdapter` owns acquisition policy: native sample-period selection,
  request expansion, deduplication, cancellation, retry/backoff, and live
  transport lifetime.
- `IntervalLoader` is the adapter's low-level range fetch operation. It knows the
  exchange/API wire format but not the broker or renderer.
- `NumericSeriesStore` is an ordered `timestamp -> value` map with packed numeric
  leaves. It owns no acquisition, interval-coverage, or resolution semantics.

## Core contracts

1. A `Sample` is one observation `{ t, value }`. Both fields are finite and `t`
   is epoch milliseconds. Acquisition normalizes batches into timestamp order.
2. Store writes are last-write-wins. The final duplicate in one batch wins, and
   a later batch replaces an earlier value at the same timestamp. Resolution or
   source identity does not affect this rule.
3. Reads select the greatest stored timestamp less than or equal to the query.
   The batch read accepts ascending query timestamps and writes parallel value
   and selected-timestamp arrays. A missing predecessor is represented by
   `NaN` for value and `-Infinity` for selected timestamp.
4. The selected timestamp lets consumers impose maximum-age or reconstruction
   policy without coupling those policies to storage. The renderer currently
   uses zero-order hold and counts a new observation only when this identity
   advances.
5. The read hot path allocates nothing when the caller supplies correctly sized
   output buffers. Its cost follows query-grid width rather than the number of
   stored observations skipped between queries.
6. A broker demand means “make at least this range available with sample
   spacing no larger than this.” It is not a literal HTTP request. An adapter
   may fetch and deliver a wider range, and the broker caches all valid samples
   in the delivered `searchedInterval`.
7. `setDemands` replaces the session's complete interest snapshot. The adapter
   may keep a live transport warm after live interest disappears, but must not
   multiply work when the viewport moves.
8. A delivery reports the range actually searched and the cadence of its
   returned samples. These may differ: a source can exhaust a fine search but
   return a coarser retained fallback. Empty results settle a range only when the
   adapter considers them authoritative. Partial responses report only the part
   searched so the remaining gap can be scheduled later.
9. Reads are side-effect-free. Only subscriptions change acquisition demand.
   Request status is `pending` or `retrying`; serialized gaps waiting behind
   active work remain visible.
10. The broker has no clock or implicit evaluation horizon. It accepts every observation
    inside an adapter's declared searched range and may select it for any read.
    The adapter alone projects the future part of demand as `pending`, schedules
    its transition into fetchable history, and manages any internal live lease.
11. `sampleRevision` changes only when the stored mapping changes
    (ingestion or clear). Pending/retry changes notify subscribers but do not
    invalidate the heatmap's numerical cache.
12. Clearing or disposing a session aborts in-flight work. Results from stale
    work must never be delivered after the generation/session is gone.

## Market boundary

`market/price.ts` is the only shared price-to-signal conversion boundary.
Market adapters parse `PricePoint`, reject non-finite or non-positive prices,
apply the natural logarithm, and emit generic `Sample` values. The broker,
store, wavelet code, and request-status logic never import a price type.
