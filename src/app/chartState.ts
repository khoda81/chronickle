import type { PriceSignalSourceId } from "../data/signal/market/market.ts";
import type { PaletteName } from "../engine/ramp.ts";
import type { WaveletMode } from "../engine/wavelet.ts";

export interface ChartState {
  readonly sourceId: PriceSignalSourceId;
  readonly symbol: string;
  readonly palette: PaletteName;
  readonly waveletMode: WaveletMode;
  readonly verticalOffset: number;
  readonly height?: number;
}

export function chartKey(sourceId: PriceSignalSourceId, symbol: string): string {
  return `${sourceId}:${symbol}`;
}

export function chartStateKey(chart: ChartState): string {
  return chartKey(chart.sourceId, chart.symbol);
}
