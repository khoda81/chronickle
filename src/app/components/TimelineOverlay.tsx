import { Pause, Play, RefreshCw } from "lucide-solid";
import { For, createSignal, onCleanup, onMount, type Accessor } from "solid-js";
import { PALETTES, paletteCssGradient, type PaletteName } from "../../engine/ramp.ts";
import type { TimelinePlayback } from "../../engine/timeline.ts";
import type { TimelineOverlayController } from "../timeline/TimelineOverlayController.ts";

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

export function TimelineOverlay(props: TimelineOverlayProps) {
  const [openPaletteId, setOpenPaletteId] = createSignal<string | null>(null);
  let nowLine!: HTMLDivElement;
  let hoverLine!: HTMLDivElement;
  let timeHover!: HTMLDivElement;

  onMount(() => {
    props.controller.attachStaticElements(nowLine, hoverLine, timeHover);
    const closePaletteOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(".timeline-price-palette, .timeline-price-palette-menu") !== null
      ) {
        return;
      }
      setOpenPaletteId(null);
    };
    document.addEventListener("pointerdown", closePaletteOnOutsidePointer);
    onCleanup(() => {
      document.removeEventListener("pointerdown", closePaletteOnOutsidePointer);
      props.controller.detachStaticElements();
    });
  });

  const choosePalette = (id: string, palette: PaletteName): void => {
    props.onPaletteChange(id, palette);
    setOpenPaletteId(null);
  };

  return (
    <>
      <div ref={nowLine} class="timeline-now-line" hidden />

      <div class="timeline-now-controls">
        <button
          type="button"
          class="timeline-icon-button timeline-reload"
          title="Reload data"
          aria-label="Reload data"
          onClick={props.onReload}
        >
          <RefreshCw aria-hidden="true" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          class="timeline-icon-button timeline-playback"
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

      <div ref={hoverLine} class="timeline-hover-line" hidden />
      <div ref={timeHover} class="timeline-time-hover" hidden />

      <For each={props.rows.map((row) => row.key)}>
        {(key) => (
          <TimelineRowChrome
            controller={props.controller}
            row={() => {
              const row = props.rows.find((candidate) => candidate.key === key);
              if (row === undefined) throw new Error(`Missing timeline overlay row ${key}`);
              return row;
            }}
            paletteOpen={openPaletteId() === key}
            onTogglePalette={() => setOpenPaletteId(openPaletteId() === key ? null : key)}
            onClosePalette={() => setOpenPaletteId(null)}
            onChoosePalette={(palette) => choosePalette(key, palette)}
            onRemove={() => props.onRemoveRow(key)}
          />
        )}
      </For>
    </>
  );
}

interface TimelineRowChromeProps {
  readonly controller: TimelineOverlayController;
  readonly row: Accessor<TimelineOverlayRowView>;
  readonly paletteOpen: boolean;
  readonly onTogglePalette: () => void;
  readonly onClosePalette: () => void;
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
        class="timeline-price-header"
        classList={{ "palette-open": props.paletteOpen }}
        hidden
        title="Drag this heatmap vertically to move through its fixed scale field"
      >
        <span>{label()}</span>
        <button
          type="button"
          class="timeline-price-palette"
          title={`Change ${label()} color map`}
          aria-label={`Change ${label()} color map`}
          aria-haspopup="listbox"
          aria-expanded={props.paletteOpen}
          onClick={(event) => {
            event.stopPropagation();
            props.onTogglePalette();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            props.onClosePalette();
            event.currentTarget.focus();
          }}
        >
          <span
            class="timeline-price-palette-bar"
            style={{ "background-image": paletteCssGradient(props.row().palette) }}
          />
          <span class="timeline-price-palette-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        <div
          class="timeline-price-palette-menu"
          role="listbox"
          aria-label={`${label()} color maps`}
          hidden={!props.paletteOpen}
        >
          <For each={PALETTE_NAMES}>
            {(palette) => (
              <button
                type="button"
                class="timeline-price-palette-option"
                role="option"
                aria-label={palette}
                aria-selected={palette === props.row().palette}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onChoosePalette(palette);
                }}
              >
                <span
                  class="timeline-price-palette-option-bar"
                  style={{ "background-image": paletteCssGradient(palette) }}
                />
              </button>
            )}
          </For>
        </div>
        <button
          type="button"
          class="timeline-price-remove"
          title={`Remove ${label()}`}
          aria-label={`Remove ${label()}`}
          onClick={(event) => {
            event.stopPropagation();
            props.onRemove();
          }}
        >
          ×
        </button>
      </div>
      <div ref={tooltip} class="timeline-signal-tooltip" hidden />
    </>
  );
}
