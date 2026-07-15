import { Select } from "@kobalte/core/select";
import { ChevronDown, Pause, Play, RefreshCw, X } from "lucide-solid";
import { For, onCleanup, onMount, type Accessor, type JSX } from "solid-js";
import { PALETTES, paletteCssGradient, type PaletteName } from "../../engine/ramp.ts";
import type { TimelinePlayback } from "../../engine/timeline.ts";
import { TIMELINE_OVERLAY_METRICS } from "../../ui/timelineOverlayMetrics.ts";
import type { TimelineOverlayController } from "../timeline/TimelineOverlayController.ts";
import styles from "./TimelineOverlay.module.css";

export interface TimelineOverlayRowView {
  readonly key: string;
  readonly sourceLabel: string;
  readonly symbol: string;
  readonly palette: PaletteName;
}

interface TimelineOverlayProps {
  readonly controller: TimelineOverlayController;
  readonly rows: readonly TimelineOverlayRowView[];
  readonly playback: TimelinePlayback;
  readonly onTogglePlayback: () => void;
  readonly onReload: () => void;
  readonly onPaletteChange: (id: string, palette: PaletteName) => void;
  readonly onRemoveRow: (id: string) => void;
}

const PALETTE_NAMES = Object.keys(PALETTES) as PaletteName[];
const OVERLAY_STYLE = {
  "--timeline-row-inset": `${TIMELINE_OVERLAY_METRICS.rowInsetPx}px`,
  "--timeline-row-inline-margin": `${TIMELINE_OVERLAY_METRICS.rowInsetPx * 2}px`,
  "--timeline-signal-tooltip-padding-x": `${TIMELINE_OVERLAY_METRICS.signalTooltip.paddingXPx}px`,
  "--timeline-signal-tooltip-border-width": `${TIMELINE_OVERLAY_METRICS.signalTooltip.borderWidthPx}px`,
  "--timeline-signal-tooltip-font": TIMELINE_OVERLAY_METRICS.signalTooltip.font,
} satisfies JSX.CSSProperties;

export function TimelineOverlay(props: TimelineOverlayProps) {
  let nowLine!: HTMLDivElement;
  let hoverLine!: HTMLDivElement;
  let timeHover!: HTMLDivElement;

  onMount(() => {
    props.controller.attachStaticElements(nowLine, hoverLine, timeHover);
    onCleanup(() => props.controller.detachStaticElements());
  });

  return (
    <div class={styles.root} style={OVERLAY_STYLE}>
      <div ref={nowLine} class={styles.nowLine} hidden />

      <div class={styles.nowControls}>
        <button
          type="button"
          class={styles.timelineButton}
          title="Reload data"
          aria-label="Reload data"
          onClick={props.onReload}
        >
          <RefreshCw aria-hidden="true" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          class={styles.timelineButton}
          aria-pressed={props.playback.mode === "following"}
          title={
            props.playback.mode === "following" ? "Pause current-time playback" : "Play from here"
          }
          aria-label={
            props.playback.mode === "following" ? "Pause current-time playback" : "Play from here"
          }
          onClick={props.onTogglePlayback}
        >
          {props.playback.mode === "following" ? (
            <Pause aria-hidden="true" strokeWidth={1.75} />
          ) : (
            <Play aria-hidden="true" strokeWidth={1.75} />
          )}
        </button>
      </div>

      <div ref={hoverLine} class={styles.hoverLine} hidden />
      <div ref={timeHover} class={styles.timeHover} hidden />

      <For each={props.rows.map((row) => row.key)}>
        {(key) => (
          <TimelineRowChrome
            controller={props.controller}
            row={() => {
              const row = props.rows.find((candidate) => candidate.key === key);
              if (row === undefined) throw new Error(`Missing timeline overlay row ${key}`);
              return row;
            }}
            onChoosePalette={(palette) => props.onPaletteChange(key, palette)}
            onRemove={() => props.onRemoveRow(key)}
          />
        )}
      </For>
    </div>
  );
}

interface TimelineRowChromeProps {
  readonly controller: TimelineOverlayController;
  readonly row: Accessor<TimelineOverlayRowView>;
  readonly onChoosePalette: (palette: PaletteName) => void;
  readonly onRemove: () => void;
}

function TimelineRowChrome(props: TimelineRowChromeProps) {
  let header!: HTMLDivElement;
  let tooltip!: HTMLDivElement;
  const key = props.row().key;
  const label = () => `${props.row().sourceLabel} · ${props.row().symbol}`;

  onMount(() => {
    props.controller.attachRow(key, header, tooltip);
    onCleanup(() => props.controller.detachRow(key));
  });

  return (
    <>
      <div
        ref={header}
        class={styles.rowHeader}
        hidden
        title="Drag this heatmap vertically to move through its fixed scale field"
      >
        <span class={styles.rowLabel}>{label()}</span>
        <Select<PaletteName>
          class={styles.paletteRoot}
          options={PALETTE_NAMES}
          value={props.row().palette}
          onChange={(palette) => {
            if (palette !== null) props.onChoosePalette(palette);
          }}
          itemComponent={(itemProps) => (
            <Select.Item item={itemProps.item} class={styles.paletteItem}>
              <Select.ItemLabel class={styles.paletteItemLabel}>
                <span
                  class={styles.paletteOptionBar}
                  style={{ "background-image": paletteCssGradient(itemProps.item.rawValue) }}
                />
              </Select.ItemLabel>
            </Select.Item>
          )}
          gutter={5}
          placement="bottom-end"
          sameWidth
          fitViewport
        >
          <Select.Trigger
            class={styles.paletteTrigger}
            title={`Change ${label()} color map`}
            aria-label={`Change ${label()} color map`}
          >
            <Select.Value<PaletteName>>
              {(state) => (
                <span
                  class={styles.paletteBar}
                  style={{ "background-image": paletteCssGradient(state.selectedOption()) }}
                />
              )}
            </Select.Value>
            <Select.Icon class={styles.paletteIcon}>
              <ChevronDown aria-hidden="true" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content class={styles.paletteContent}>
              <Select.Listbox class={styles.paletteListbox} />
            </Select.Content>
          </Select.Portal>
        </Select>
        <button
          type="button"
          class={styles.removeRow}
          title={`Remove ${label()}`}
          aria-label={`Remove ${label()}`}
          onClick={props.onRemove}
        >
          <X aria-hidden="true" />
        </button>
      </div>
      <div ref={tooltip} class={styles.signalTooltip} hidden />
    </>
  );
}
