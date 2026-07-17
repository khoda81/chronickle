import { Popover } from "@kobalte/core/popover";
import { Settings2 } from "lucide-solid";
import type { PaletteName } from "../../engine/ramp.ts";
import { computeWaveletField, type WaveletMode } from "../../engine/wavelet.ts";
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

          <div class={styles.colorRow} role="group" aria-labelledby={`color-${props.id}`}>
            <span
              id={`color-${props.id}`}
              class={`${styles.colorLabel} ${controlStyles.sectionLabel}`}>
              Color
            </span>
            <PalettePicker
              label={props.label}
              value={props.palette}
              onChange={props.onPaletteChange}
            />
          </div>
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
      <path class={styles.previewCurve} d={KERNEL_PREVIEW_PATHS[props.mode]} />
    </svg>
  );
}

const KERNEL_PREVIEW_PATHS: Record<WaveletMode, string> = {
  centered: kernelPreviewPath("centered"),
  causal: kernelPreviewPath("causal"),
};

/** Sample the production transform's response rather than approximating its named kernel. */
function kernelPreviewPath(mode: WaveletMode): string {
  const sampleCount = 61;
  const impulse = new Float64Array(sampleCount);
  impulse[mode === "centered" ? Math.floor(sampleCount / 2) : 8] = 1;
  const response = computeWaveletField(impulse, 1, new Float64Array([6]), mode).values;
  let peak = 0;
  for (const value of response) peak = Math.max(peak, value);
  if (!(peak > 0)) return "M2 24.5H62";

  const points: string[] = [];
  for (let index = 0; index < response.length; index++) {
    const x = 2 + (index / (sampleCount - 1)) * 60;
    const y = 24 - (Math.max(0, response[index]!) / peak) * 20;
    points.push(`${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`);
  }
  return points.join("");
}
