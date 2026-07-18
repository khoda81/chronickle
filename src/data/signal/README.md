# Signal data model

This directory is deliberately independent of prices, exchanges, and network
requests. It exposes a synchronous sampled-signal cache to the renderer and a
small demand/sample boundary to arbitrary signal producers. `market/` is one
producer family: it validates positive prices and converts them to log-price
samples before they reach the broker.

## Roles

- `Broker` owns subscriptions and one cached numeric series. A read both
  describes the subscriber's current query grid and immediately returns the
  best cached predecessor for every query timestamp.
- `SignalAdapter` owns all production policy. It may make HTTP requests,
  evaluate a function synchronously, run expensive asynchronous computation,
  retain coverage metadata, retry, or do nothing when it already considers a
  demand satisfied.
- `IntervalLoader` and `createPollingSignalSource` are optional machinery for
  range-based APIs. Their searched ranges, native resolutions, retries, and
  live leases are private adapter implementation details.
- `NumericSeriesStore` is an ordered `timestamp -> value` map with packed
  numeric leaves. It owns no demand, coverage, resolution, or source semantics.

## Broker/adapter boundary

`SignalDemand` contains only a time range and the number of regular query
points across that range. `AdapterSession.setDemands` replaces the complete
snapshot of active subscriber interest. The broker forwards that snapshot when
a subscription's query geometry changes; it never decides that a network
request, retry, or particular source resolution is required.

The adapter emits `Sample[]` and may independently replace a snapshot of
interval-scoped `SignalReport` messages. The broker normalizes and upserts every
valid sample but treats reports as opaque commentary: they can trigger a redraw
without changing `sampleRevision`, coverage, demand, or returned values. Empty
and duplicate sample deliveries cause no redraw unless the report snapshot also
changed. Acquisition errors are additionally sent to the application's error
handler.

Reports have `info`, `warn`, or `error` presentation kinds. Where their
intervals overlap, later entries in the adapter's snapshot paint over earlier
ones. This lets each adapter choose its own priority while producing a
deterministic non-overlapping reporting frontier. A report never becomes
evidence that an interval was searched or satisfied.

This boundary deliberately cannot distinguish among an unsearched range, a
market closure, an unavailable native resolution, pending computation, or a
function that has no observations. Those are producer-specific states. If an
empty region remains wrong until refresh, the adapter is the component that
owns that bug.

## Core invariants

1. A `Sample` is one observation `{ t, value }`. Both fields are finite and `t`
   is epoch milliseconds. Ingestion sorts batches by timestamp.
2. Writes are last-write-wins. The final duplicate in a batch wins, and a later
   batch replaces an earlier value at the same timestamp.
3. Reads select the greatest stored timestamp less than or equal to each query.
   Missing predecessors write `NaN` to the value output and `-Infinity` to the
   selected-time output.
4. The selected timestamp lets consumers apply maximum-age or reconstruction
   policy without putting signal semantics in the store. The current renderer
   uses zero-order hold and counts a new observation only when this identity
   advances.
5. Batched reads accept ascending query timestamps. With correctly sized
   output buffers, the hot path allocates nothing and its cost follows query
   width rather than the number of skipped observations.
6. `sampleRevision` changes only when the stored mapping changes or the cache is
   cleared. Adapter scheduling and unchanged deliveries do not change it.
7. One broker subscription owns one adapter demand. Disposing it removes that
   demand; disposing the broker aborts the adapter session.
8. A synchronous adapter emission is visible in the read that caused the
   demand update. It does not invalidate that same subscriber, because the
   caller is already receiving the new cache contents.
9. Reports are replaceable adapter-owned snapshots. They describe source state
   for people and diagnostics only; no broker or renderer decision may depend
   on their presence, kind, interval, or message.

## Polling adapter invariants

The generic polling coordinator is below the public broker/adapter boundary.
Its `AdapterBatch.searchedInterval` means the source actually examined that
range, even when `samples` is empty. It must overlap the required range so the
coordinator can make progress instead of immediately scheduling the same gap.
`sampleResolutionMs` records a returned fallback cadence when it differs from
the attempted native resolution. Neither field reaches the broker.

The coordinator owns request expansion, per-resolution coverage, cancellation,
retry/backoff, future scheduling, and live-lease lifetime. `setDemands` still
replaces its full interest snapshot, so viewport movement cannot multiply work.
Clearing or disposing a session aborts in-flight work, and stale results are
never emitted.

## Market boundary

`market/price.ts` is the shared price-to-signal conversion boundary. Market
adapters parse `PricePoint`, reject non-finite or non-positive prices, apply the
natural logarithm, and emit generic `Sample` values. The broker, store, and
wavelet code never import a price type.
