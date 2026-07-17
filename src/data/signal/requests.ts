import { Interval } from "../../core/interval.ts";

interface RequestSegmentBase {
  readonly range: Interval;
  readonly samplePeriodMs: number;
}

export type RequestSegment =
  | (RequestSegmentBase & { readonly state: "pending" })
  | (RequestSegmentBase & {
      readonly state: "retrying";
      readonly attempt: number;
      readonly message: string;
      readonly retryAtMs: number;
    });

export type RequestState = RequestSegment["state"];
