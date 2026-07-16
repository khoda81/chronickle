# Changelog

All notable changes to Chronickle are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/) and the project
follows semantic versioning for tagged releases.

## [Unreleased]

No changes yet.

## [v1.3.0] - 2026-07-16

This release covers all commits after [`v1.2.0`](#v120---2026-07-15).

### Added

- **Per-row wavelet mode.** Wavelet kernel selection moved from a global header
  control to a per-chart property, persisted as part of each chart's state
  (persistence bumped to v3, with automatic migration of the legacy global
  setting into every existing chart). Each row's kernel change invalidates its
  own broker subscription only.
- **Inline feed rename.** `FeedChip` is now its own component: click to edit the
  feed name, `Enter`/`Escape`/blur to commit or cancel, wired through to
  `FeedRegistry.rename`.
- **Drag-to-collapse row removal.** Signal rows can be removed by dragging their
  resize boundary fully closed. A live collapse hint on the row header
  communicates progress, and rows under `ROW_REMOVE_THRESHOLD` are batched for
  removal during layout flush.
- **`ChartSettings` popover.** A Kobalte `Popover` with a radio group and inline
  SVG kernel previews (Gaussian / Erlang) replaces the old global wavelet
  selector.
- **`PalettePicker` deck scrubber.** A custom palette picker where hover/wheel
  expands the deck, the selected swatch stays centered via a CSS transform on
  the deck itself, and pointer leave collapses it. Replaces the Kobalte
  `Select` for palettes.
- **Interactive event tooltip.** The pointer can move from the canvas onto the
  event tooltip card and click its links without the crosshair and hover-owned
  labels disappearing. Canvas `pointerleave` now schedules a deferred clear
  that the tooltip cancels via `onPointerEnter`.
- **Layered stylesheet architecture.** `src/styles.css` was split into
  `src/styles/{tokens,reset,global}.css` plus scoped `*.module.css` files per
  component, with `src/ui/timelineOverlayMetrics.ts` as the single source of
  truth for canvas-coupled overlay geometry (consumed by the engine, the
  overlay controller, and the DOM via CSS custom properties).
- **Kobalte primitives.** `@kobalte/core` `Select`/`Combobox` replace
  hand-rolled dropdowns for accessibility and keyboard support, exposed
  through a reusable `ui/SelectField.tsx`.
- **Accessibility improvements.** `main`/`header`/`section` landmarks,
  `aria-labelledby` section labels, `aria-pressed` on toggle buttons,
  `aria-label` on icon buttons, focus-visible outlines, and a form submit
  path for symbol entry.

### Changed

- **Row reconciliation by identity.** `Timeline.setSignalRows` now preserves
  each surviving row's broker subscription, demand, eval time, hover samples,
  and height when rows are added, removed, or reordered, instead of tearing
  down every row and rebuilding. Removed brokers are disposed only after the
  timeline is re-synced, so remaining rows keep their subscriptions warm.
- **Initial timeline rows.** Signal rows are now built up front and passed
  directly to the `Timeline` constructor, eliminating the empty-then-
  `setSignalRows` boot sequence that tore down subscriptions on the first
  frame.
- **Row header layout.** Row labels are now symbol-first
  (`rowSymbol`/`rowSeparator`/`rowSource`) with a flex baseline layout and
  fit-content header width; `removedChartLabels` uses the same format.
- **Collapse affordance.** The floating `collapseHint` badge was replaced with
  a `Trash2` remove button whose color mixes toward error-red as collapse
  progress increases, so a single element communicates both the idle and
  collapsing state. `ROW_REMOVE_THRESHOLD` (12 → 64) and
  `ROW_COLLAPSE_HINT_HEIGHT` (72 → 128) were raised, and `collapseProgress` is
  now based on `(height - threshold)` so the hint ramps across the collapsible
  range rather than the full row height.
- **Pan pauses playback.** Panning now always pauses playback (previously only
  when coming from `"following"` mode) and routes through `setPlayback` to keep
  the change centralized.
- **Signal tooltip connector.** The leader line now starts from the vertical
  crosshair line (`vlineX`) instead of the anchor point, keeping it aligned
  with the crosshair.
- **State migration to a store.** Application state moved off ad-hoc signals to
  a consolidated store.
- **Range refactor.** The time-range handling was refactored into a dedicated
  `Range` representation.
- **Tooltip anchor and redraw logic.** Adjusted across several commits
  (`ea2fa4f9a0ba`, `ac30b08b2927`, `dec722b4079a`, `qpzumnol` follow-ups).

### Removed

- **Global wavelet selector** from `Header`, replaced by per-row `ChartSettings`.
- **Per-row minimum height.** `MIN_SIGNAL_ROW_HEIGHT` was renamed to
  `DEFAULT_SIGNAL_ROW_HEIGHT` and rows can now shrink to zero, enabling
  drag-to-collapse removal.
- **Canvas-drawn resize handles**, since the row header now signals
  draggability.
- **Unused `--color-success` token.**
- **`ChevronDown` icon** and `Popover.Title` from the settings trigger.
- **`saturate(145%)`** from `--glass-blur`.

### Fixed

- **Tooltip text assignment** simplified (removed the redundant
  `textContent !== text` guard in `TimelineOverlayController`).
- **`PalettePicker` sizing** switched from `flex: 0 0 6.5rem` to
  `width: 6.5rem` + `flex-shrink: 0` for predictable sizing.
- **`--glass-fill-strong` opacity** reverted from 0.94 to 0.46.
- **Kobalte listbox reset** in `reset.css` (`margin`/`padding`/`list-style`)
  and `min-width: 0` / fill labels on `SelectField` and `TimelineOverlay`
  items so gradient bar content sizes correctly.

## [v1.2.0] - 2026-07-15

Improved tooltip.

## [v1.1.1] - 2026-07-15

Improve redraw logic.

## [v1.1.0] - 2026-07-15

Improved playback UX.

## [v1.0.0] - 2026-07-14

Add demo screenshot.

## [v0.4.1] - 2026-07-14

Cleanup chart interface.

## [v0.4.0] - 2026-07-13

Fix backoff bugs.

## [v0.3.0] - 2026-07-13

Multi ticker support.

## [v0.2.0] - 2026-07-13

Fix broker bug.

## [v0.1.0] - 2026-06-28

CI: add Pages deploy workflow, README, and Vite base path.
