/**
 * Native resolution selection used inside polling adapters.
 *
 * Each source advertises its sample periods (in ms), finest→coarsest. Given
 * the regular demand grid's spacing, `pickResolution` returns the coarsest
 * native period that is no wider than the grid. If the source cannot satisfy
 * the spacing, it returns the finest available period as its best effort.
 *
 * Example (Nobitex, periods in ms):
 *   spacing = 1min..4.999min   -> 60s    ("1")
 *   spacing = 5min..14.999min  -> 300s   ("5")
 *   spacing = 15min..29.999min -> 900s   ("15")
 *   spacing = 30min..59.999min -> 1800s  ("30")
 *   ...
 *
 * The broker never sees native resolutions or this selection process.
 */

/**
 * Pick the coarsest native period `<= targetSpacingMs`, or the finest available
 * if none satisfy the constraint.
 *
 * @param nativePeriodsMs  Ascending (finest→coarsest) sample periods in ms.
 *                         Must be non-empty, positive, ascending.
 * @param targetSpacingMs  Spacing of the adapter demand grid, in ms.
 */
export function pickResolution(
  nativePeriodsMs: readonly number[],
  targetSpacingMs: number,
): number {
  if (nativePeriodsMs.length === 0) {
    throw new Error("pickResolution: nativePeriodsMs must be non-empty");
  }
  if (!(targetSpacingMs > 0)) {
    throw new Error(`pickResolution: targetSpacingMs must be positive, got ${targetSpacingMs}`);
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

  // Find the largest period that is <= targetSpacingMs (coarsest satisfying).
  // nativePeriodsMs is ascending, so walk from the end.
  for (let i = nativePeriodsMs.length - 1; i >= 0; i--) {
    const p = nativePeriodsMs[i]!;
    if (p <= targetSpacingMs) return p;
  }

  // None satisfy; return the finest available.
  return nativePeriodsMs[0]!;
}
