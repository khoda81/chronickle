import { ChevronDown } from "lucide-solid";
import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { PALETTES, paletteCssGradient, type PaletteName } from "../../engine/ramp.ts";
import styles from "./PalettePicker.module.css";

const PALETTE_NAMES = Object.keys(PALETTES) as PaletteName[];

interface PalettePickerProps {
  readonly label: string;
  readonly value: PaletteName;
  readonly onChange: (palette: PaletteName) => void;
}

/**
 * Compact palette scrubber for timeline rows.
 *
 * Unlike a general-purpose Select, this intentionally behaves like a deck:
 * hover or wheel expands it, the selected swatch stays centered over the
 * trigger, and leaving collapses the deck back to the selected swatch.
 */
export function PalettePicker(props: PalettePickerProps) {
  const [open, setOpen] = createSignal(false);
  let root!: HTMLDivElement;
  let listbox: HTMLDivElement | undefined;
  let wheelDelta = 0;

  const selectedIndex = () => Math.max(0, PALETTE_NAMES.indexOf(props.value));

  const centerSelected = (): void => {
    if (!open()) return;
    queueMicrotask(() => {
      const box = listbox;
      const selected = box?.querySelector<HTMLElement>("[aria-selected='true']");
      if (box === undefined || selected === null || selected === undefined) return;
      const top = selected.offsetTop - (box.clientHeight - selected.offsetHeight) / 2;
      box.scrollTo({ top, behavior: "smooth" });
    });
  };

  createEffect(() => {
    props.value;
    centerSelected();
  });

  createEffect(() => {
    if (!open()) return;
    const closeOutside = (event: PointerEvent): void => {
      if (!root.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside, true);
    onCleanup(() => document.removeEventListener("pointerdown", closeOutside, true));
  });

  const choose = (palette: PaletteName): void => {
    if (palette !== props.value) props.onChange(palette);
  };

  const move = (delta: number): void => {
    const next = Math.max(0, Math.min(PALETTE_NAMES.length - 1, selectedIndex() + delta));
    choose(PALETTE_NAMES[next]!);
    setOpen(true);
    centerSelected();
  };

  const onWheel = (event: WheelEvent): void => {
    if (event.deltaY === 0) return;
    event.preventDefault();
    const scale =
      event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
        ? 1
        : event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : 100;
    wheelDelta += event.deltaY * scale;
    if (Math.abs(wheelDelta) < 24) return;
    move(wheelDelta > 0 ? 1 : -1);
    wheelDelta = 0;
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        event.preventDefault();
        move(-1);
        break;
      case "Home":
        event.preventDefault();
        choose(PALETTE_NAMES[0]!);
        setOpen(true);
        break;
      case "End":
        event.preventDefault();
        choose(PALETTE_NAMES[PALETTE_NAMES.length - 1]!);
        setOpen(true);
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        break;
    }
  };

  return (
    <div
      ref={root}
      class={styles.root}
      onPointerEnter={() => {
        setOpen(true);
        centerSelected();
      }}
      onPointerLeave={() => {
        wheelDelta = 0;
        setOpen(false);
      }}
      onWheel={onWheel}
    >
      <button
        type="button"
        class={styles.trigger}
        title={`Scroll or click to change ${props.label} color map`}
        aria-label={`Change ${props.label} color map`}
        aria-haspopup="listbox"
        aria-expanded={open()}
        onClick={() => {
          setOpen(true);
          centerSelected();
        }}
        onKeyDown={onKeyDown}
      >
        <span
          class={styles.bar}
          style={{ "background-image": paletteCssGradient(props.value) }}
          aria-hidden="true"
        />
        <ChevronDown class={styles.icon} aria-hidden="true" />
      </button>

      <Show when={open()}>
        <div class={styles.deck}>
          <div
            ref={listbox}
            class={styles.listbox}
            role="listbox"
            aria-label={`${props.label} color maps`}
          >
            <For each={PALETTE_NAMES}>
              {(palette) => (
                <button
                  type="button"
                  class={styles.item}
                  classList={{ [styles.selected!]: palette === props.value }}
                  role="option"
                  aria-selected={palette === props.value}
                  aria-label={palette}
                  onClick={() => choose(palette)}
                >
                  <span
                    class={styles.optionBar}
                    style={{ "background-image": paletteCssGradient(palette) }}
                    aria-hidden="true"
                  />
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}
