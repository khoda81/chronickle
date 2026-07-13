import { Range } from "../../engine/range.ts";

export interface ReturnPoint {
  readonly t: number;
  readonly deltaLogPrice: number;
}

export interface ReturnBin {
  readonly index: number;
  readonly range: Range;
  /** Signed log-return mass in this bin. */
  readonly sum: number;
  /** Absolute log-return mass, useful for a later activity/volatility view. */
  readonly absoluteSum: number;
  /** First signed temporal moment around the bin center, in log-return·ms. */
  readonly firstMoment: number;
  readonly count: number;
}

interface MutableBin {
  sum: number;
  absoluteSum: number;
  firstMoment: number;
  count: number;
}

interface PyramidLevel {
  readonly widthMs: number;
  readonly bins: ReadonlyMap<number, ReturnBin>;
}

/**
 * Immutable dyadic hierarchy of the log-return measure.
 *
 * Parent sums are exact. The first moment permits a second-order spatial
 * approximation when a smooth kernel varies across a coarse bin, without
 * baking a particular kernel into storage.
 */
export class ReturnPyramid {
  private constructor(
    readonly baseBinMs: number,
    readonly originMs: number,
    private readonly levels: readonly PyramidLevel[],
  ) {}

  static from(points: readonly ReturnPoint[], baseBinMs: number, originMs = 0): ReturnPyramid {
    if (!(baseBinMs > 0) || !Number.isFinite(baseBinMs)) {
      throw new Error(`ReturnPyramid: invalid base bin width ${baseBinMs}`);
    }
    if (!Number.isFinite(originMs)) {
      throw new Error(`ReturnPyramid: invalid origin ${originMs}`);
    }

    const base = new Map<number, MutableBin>();
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      if (!Number.isFinite(p.t) || !Number.isFinite(p.deltaLogPrice)) {
        throw new Error(`ReturnPyramid: non-finite point at index ${i}`);
      }
      const index = Math.floor((p.t - originMs) / baseBinMs);
      const center = originMs + (index + 0.5) * baseBinMs;
      const bin = base.get(index) ?? { sum: 0, absoluteSum: 0, firstMoment: 0, count: 0 };
      bin.sum += p.deltaLogPrice;
      bin.absoluteSum += Math.abs(p.deltaLogPrice);
      bin.firstMoment += (p.t - center) * p.deltaLogPrice;
      bin.count++;
      base.set(index, bin);
    }

    const levels: PyramidLevel[] = [];
    let widthMs = baseBinMs;
    let current = freezeLevel(base, widthMs, originMs);
    levels.push(current);

    // Sparse indices still converge under repeated dyadic parent mapping.
    while (current.bins.size > 1 && levels.length < 53) {
      widthMs *= 2;
      const parent = new Map<number, MutableBin>();
      for (const child of current.bins.values()) {
        const index = Math.floor(child.index / 2);
        const center = originMs + (index + 0.5) * widthMs;
        const childCenter = (child.range.min + child.range.max) / 2;
        const bin = parent.get(index) ?? {
          sum: 0,
          absoluteSum: 0,
          firstMoment: 0,
          count: 0,
        };
        bin.sum += child.sum;
        bin.absoluteSum += child.absoluteSum;
        bin.firstMoment += child.firstMoment + (childCenter - center) * child.sum;
        bin.count += child.count;
        parent.set(index, bin);
      }
      current = freezeLevel(parent, widthMs, originMs);
      levels.push(current);
    }

    return new ReturnPyramid(baseBinMs, originMs, levels);
  }

  get levelCount(): number {
    return this.levels.length;
  }

  /** Largest stored bin width not exceeding `maxBinMs`. */
  levelWidth(maxBinMs: number): number {
    return this.level(maxBinMs).widthMs;
  }

  /** Return bins intersecting `range` at the coarsest acceptable level. */
  query(range: Range, maxBinMs: number): readonly ReturnBin[] {
    const level = this.level(maxBinMs);
    const out: ReturnBin[] = [];
    for (const bin of level.bins.values()) {
      if (bin.range.max <= range.min || bin.range.min >= range.max) continue;
      out.push(bin);
    }
    out.sort((a, b) => a.index - b.index);
    return out;
  }

  private level(maxBinMs: number): PyramidLevel {
    if (!(maxBinMs > 0) || !Number.isFinite(maxBinMs)) {
      throw new Error(`ReturnPyramid: invalid query bin width ${maxBinMs}`);
    }
    let selected = this.levels[0]!;
    for (const level of this.levels) {
      if (level.widthMs > maxBinMs) break;
      selected = level;
    }
    return selected;
  }
}

function freezeLevel(
  source: ReadonlyMap<number, MutableBin>,
  widthMs: number,
  originMs: number,
): PyramidLevel {
  const bins = new Map<number, ReturnBin>();
  for (const [index, value] of source) {
    const min = originMs + index * widthMs;
    bins.set(index, {
      index,
      range: Range.create(min, min + widthMs),
      sum: value.sum,
      absoluteSum: value.absoluteSum,
      firstMoment: value.firstMoment,
      count: value.count,
    });
  }
  return { widthMs, bins };
}
