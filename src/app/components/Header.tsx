import type { WaveletMode } from "../../engine/wavelet.ts";

interface HeaderProps {
  readonly waveletMode: WaveletMode;
  readonly onWaveletModeChange: (mode: WaveletMode) => void;
}

export function Header(props: HeaderProps) {
  return (
    <div class="header">
      <h1>Chronickle</h1>
      <a
        class="github-link"
        href="https://github.com/khoda81/chronickle"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open the Chronickle repository on GitHub"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M8 0C3.58 0 0 3.64 0 8.13c0 3.59 2.29 6.64 5.47 7.71.4.08.55-.18.55-.39 0-.19-.01-.83-.01-1.5-2.01.38-2.53-.5-2.69-.96-.09-.23-.48-.96-.82-1.15-.28-.15-.68-.53-.01-.54.63-.01 1.08.59 1.23.83.72 1.23 1.87.88 2.33.67.07-.53.28-.88.51-1.08-1.78-.21-3.64-.91-3.64-4.02 0-.89.31-1.62.82-2.19-.08-.21-.36-1.04.08-2.16 0 0 .67-.22 2.2.84A7.5 7.5 0 0 1 8 3.91c.68 0 1.36.09 2 .28 1.53-1.06 2.2-.84 2.2-.84.44 1.12.16 1.95.08 2.16.51.57.82 1.3.82 2.19 0 3.12-1.87 3.81-3.65 4.02.29.25.54.74.54 1.5 0 1.08-.01 1.95-.01 2.22 0 .21.15.47.55.39A8.14 8.14 0 0 0 16 8.13C16 3.64 12.42 0 8 0Z"
          />
        </svg>
        <span class="github-tooltip" role="tooltip">
          View on GitHub
        </span>
      </a>
      <select
        class="wavelet-mode"
        value={props.waveletMode}
        onChange={(event) => props.onWaveletModeChange(event.currentTarget.value as WaveletMode)}
      >
        <option value="centered">Centered growth</option>
        <option value="causal">Causal growth</option>
      </select>
    </div>
  );
}
