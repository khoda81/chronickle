import { Show, createEffect, onCleanup, onMount } from "solid-js";
import type { RssFeed } from "../../domain.ts";
import type { HoverInfo } from "../../engine/timeline.ts";
import type { TimelineOverlayController } from "../timeline/TimelineOverlayController.ts";
import styles from "./EventTooltip.module.css";

export interface EventTooltipModel {
  readonly event: HoverInfo;
  readonly feed: RssFeed;
}

interface EventTooltipProps {
  readonly controller: TimelineOverlayController;
  readonly value: EventTooltipModel | null;
}

export function EventTooltip(props: EventTooltipProps) {
  let element!: HTMLDivElement;

  onMount(() => {
    props.controller.attachEventTooltip(element);
    onCleanup(() => props.controller.detachEventTooltip(element));
  });

  createEffect(() => {
    if (props.value === null) return;
    queueMicrotask(() => props.controller.refreshEventTooltipPosition());
  });

  return (
    <div
      ref={element}
      class={styles.tooltip}
      classList={{ [styles.hidden!]: props.value === null }}
      style={{
        "--outlet-color": props.value?.feed.color ?? "rgba(148, 163, 184, 0.9)",
      }}
    >
      <Show when={props.value}>
        {(value) => (
          <>
            <span class={styles.source}>
              {value().feed.source} · {new Date(value().event.t).toLocaleString()}
            </span>
            <a
              class={styles.link}
              href={value().event.link}
              target="_blank"
              rel="noopener noreferrer"
            >
              {value().event.title}
            </a>
            <Show when={value().event.summary.length > 0}>
              <p class={styles.summary}>{value().event.summary}</p>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
