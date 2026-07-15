/**
 * Resolution selection for the `maxDeltaTMs` fetcher contract.
 *
 * Each fetcher advertises its native sample periods (in ms), finest→coarsest.
 * Given a requested `maxDeltaTMs` ("give me points spaced at most this far
 * apart"), `pickResolution` returns the **finest** native period that is
 * `<= maxDeltaTMs` — i.e. the coarsest one that satisfies the constraint while
 * minimizing over-fetching. If even the finest native period exceeds
 * `maxDeltaTMs`, that finest period is returned (the request cannot be met
 * exactly; the fetcher does the best it can and the staircase evaluator
 * handles the resulting sparsity).
 *
 * Example (Nobitex, periods in ms):
 *   maxDeltaT = 1min..4.999min  -> 60s    ("1")
 *   maxDeltaT = 5min..14.999min -> 300s   ("5")
 *   maxDeltaT = 15min..29.999min -> 900s  ("15")
 *   maxDeltaT = 30min..59.999min -> 1800s ("30")
 *   ...
 *
 * The broker never sees native resolution strings; it only reasons about
 * sample periods in ms.
 */

/**
 * Pick the coarsest native period `<= maxDeltaTMs`, or the finest available
 * if none satisfy the constraint.
 *
 * @param nativePeriodsMs  Ascending (finest→coarsest) sample periods in ms.
 *                         Must be non-empty, positive, ascending.
 * @param maxDeltaTMs      Requested maximum spacing between samples, in ms.
 *                         Must be positive.
 */
export function pickResolution(nativePeriodsMs: readonly number[], maxDeltaTMs: number): number {
  if (nativePeriodsMs.length === 0) {
    throw new Error("pickResolution: nativePeriodsMs must be non-empty");
  }
  if (!(maxDeltaTMs > 0)) {
    throw new Error(`pickResolution: maxDeltaTMs must be positive, got ${maxDeltaTMs}`);
  }

  // Validate ascending + positive once, at the boundary.
  let prev = 0;
  for (const p of nativePeriodsMs) {
    if (!(p > prev)) {
      throw new Error(
        `pickResolution: nativePeriodsMs must be strictly ascending; got ${p} after ${prev}`,
      );
    }
    prev = p;
  }

  // Find the largest period that is <= maxDeltaTMs (coarsest satisfying).
  // nativePeriodsMs is ascending, so walk from the end.
  for (let i = nativePeriodsMs.length - 1; i >= 0; i--) {
    const p = nativePeriodsMs[i]!;
    if (p <= maxDeltaTMs) return p;
  }

  // None satisfy; return the finest available.
  return nativePeriodsMs[0]!;
}
