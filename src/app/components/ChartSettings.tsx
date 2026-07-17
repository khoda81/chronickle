import { Popover } from "@kobalte/core/popover";
import { Settings2 } from "lucide-solid";
import type { PaletteName } from "../../engine/ramp.ts";
import type { WaveletMode } from "../../engine/wavelet.ts";
import surfaceStyles from "../../styles/floatingSurface.module.css";
import controlStyles from "./ui/Control.module.css";
import styles from "./ChartSettings.module.css";
import { PalettePicker } from "./PalettePicker.tsx";

interface ChartSettingsProps {
  readonly id: string;
  readonly label: string;
  readonly palette: PaletteName;
  readonly waveletMode: WaveletMode;
  readonly onPaletteChange: (palette: PaletteName) => void;
  readonly onWaveletModeChange: (mode: WaveletMode) => void;
}

const KERNELS = [
  { value: "centered", name: "Gaussian", detail: "Centered · symmetric context" },
  { value: "causal", name: "Erlang", detail: "Causal · past-only context" },
] as const satisfies readonly { value: WaveletMode; name: string; detail: string }[];

export function ChartSettings(props: ChartSettingsProps) {
  return (
    <Popover placement="bottom-end" gutter={6} flip slide overflowPadding={8} fitViewport>
      <Popover.Trigger
        class={styles.trigger}
        classList={{ [controlStyles.iconAction!]: true }}
        title={`Settings`}
        aria-label={`Open ${props.label} settings`}>
        <Settings2 aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class={styles.content} classList={{ [surfaceStyles.menu!]: true }}>
          <fieldset class={styles.fieldset}>
            <legend class={`${styles.legend} ${controlStyles.sectionLabel}`}>Curve</legend>
            <div class={styles.kernelGrid}>
              {KERNELS.map(kernel => (
                <label
                  class={styles.kernelOption}
                  classList={{ [styles.kernelSelected!]: props.waveletMode === kernel.value }}>
                  <input
                    class={controlStyles.visuallyHidden}
                    type="radio"
                    name={`kernel-${props.id}`}
                    value={kernel.value}
                    checked={props.waveletMode === kernel.value}
                    onChange={() => props.onWaveletModeChange(kernel.value)}
                  />
                  <KernelPreview mode={kernel.value} />
                  <span class={styles.kernelText}>
                    <strong>{kernel.name}</strong>
                    <small>{kernel.detail}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset class={styles.fieldset}>
            <legend class={`${styles.legend} ${controlStyles.sectionLabel}`}>Color</legend>

            <PalettePicker
              label={props.label}
              value={props.palette}
              onChange={props.onPaletteChange}
            />
          </fieldset>
          <Popover.Arrow class={styles.arrow} />
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  );
}

function KernelPreview(props: { readonly mode: WaveletMode }) {
  return (
    <svg class={styles.preview} viewBox="0 0 64 28" aria-hidden="true">
      <path class={styles.previewAxis} d="M2 24.5H62" />
      {props.mode === "centered" ? (
        <path
          class={styles.previewCurve}
          d="M3 24C16 24 19 22 24 13C27 7 29 4 32 4C35 4 37 7 40 13C45 22 48 24 61 24"
        />
      ) : (
        <path
          class={styles.previewCurve}
          d="M3 24H17C19 11 23 5 28 5C35 5 39 13 44 18C49 22 54 23.5 61 24"
        />
      )}
    </svg>
  );
}
