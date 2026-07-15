import { For, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import {
  PRICE_SIGNAL_SOURCES,
  priceSignalSource,
  type PriceSignalSourceId,
} from "../../data/signal/market/market.ts";
import { filterMarketSymbols, type MarketSymbol } from "../../data/signal/market/symbols.ts";

interface MarketControlsProps {
  readonly onAdd: (sourceId: PriceSignalSourceId, symbol: string) => boolean;
  readonly onLoadError: (message: string) => void;
}

export function MarketControls(props: MarketControlsProps) {
  const initialSource = PRICE_SIGNAL_SOURCES[0]!;
  const [sourceId, setSourceId] = createSignal<PriceSignalSourceId>(initialSource.id);
  const [symbol, setSymbol] = createSignal(initialSource.examples[0]?.symbol ?? "");
  const [options, setOptions] = createSignal<readonly MarketSymbol[]>(initialSource.examples);
  const [open, setOpen] = createSignal(false);
  const [highlighted, setHighlighted] = createSignal(-1);
  let picker!: HTMLDivElement;
  let input!: HTMLInputElement;
  let loadGeneration = 0;

  const matches = createMemo(() => filterMarketSymbols(options(), symbol()));

  const close = (): void => {
    setOpen(false);
    setHighlighted(-1);
  };

  const select = (option: MarketSymbol): void => {
    setSymbol(option.symbol);
    close();
    input.focus();
  };

  const add = (): void => {
    if (props.onAdd(sourceId(), symbol())) input.select();
  };

  createEffect(
    on(sourceId, (nextSourceId) => {
      const source = priceSignalSource(nextSourceId);
      if (source === null) return;
      const generation = ++loadGeneration;
      setOptions(source.examples);
      setHighlighted(-1);
      setSymbol(source.examples[0]?.symbol ?? "");
      void source
        .loadSymbols()
        .then((loaded) => {
          if (generation !== loadGeneration) return;
          const bySymbol = new Map<string, MarketSymbol>();
          for (const option of [...source.examples, ...loaded]) bySymbol.set(option.symbol, option);
          setOptions([...bySymbol.values()]);
        })
        .catch((error: unknown) => {
          if (generation !== loadGeneration) return;
          console.warn(`${source.label} ticker discovery failed`, error);
          props.onLoadError(
            `${source.label} ticker list unavailable; examples and free-form entry still work`,
          );
        });
    }),
  );

  onMount(() => {
    const onDocumentPointerDown = (event: PointerEvent): void => {
      if (!picker.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onDocumentPointerDown);
    onCleanup(() => document.removeEventListener("pointerdown", onDocumentPointerDown));
  });

  return (
    <div class="market-controls">
      <select
        class="market-source"
        value={sourceId()}
        onChange={(event) => {
          setSourceId(event.currentTarget.value as PriceSignalSourceId);
          close();
        }}
      >
        <For each={PRICE_SIGNAL_SOURCES}>
          {(source) => <option value={source.id}>{source.label}</option>}
        </For>
      </select>
      <div
        ref={picker}
        class="symbol-picker"
        onFocusOut={() => {
          queueMicrotask(() => {
            if (!picker.contains(document.activeElement)) close();
          });
        }}
      >
        <input
          ref={input}
          class="market-symbol"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open()}
          aria-controls="market-symbol-menu"
          aria-activedescendant={
            highlighted() >= 0 ? `market-symbol-option-${highlighted()}` : undefined
          }
          placeholder="Ticker, e.g. BTCUSDT"
          spellcheck={false}
          value={symbol()}
          onInput={(event) => {
            setSymbol(event.currentTarget.value);
            setHighlighted(-1);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            const visible = matches();
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const direction = event.key === "ArrowDown" ? 1 : -1;
              setHighlighted((current) =>
                visible.length === 0 ? -1 : (current + direction + visible.length) % visible.length,
              );
              setOpen(true);
              queueMicrotask(() =>
                picker.querySelector(".highlighted")?.scrollIntoView({ block: "nearest" }),
              );
              return;
            }
            if (event.key === "Escape") {
              close();
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              const option = visible[highlighted()];
              if (option === undefined) add();
              else select(option);
            }
          }}
        />
        <button
          type="button"
          class="symbol-toggle"
          title="Show available tickers"
          aria-label="Show available tickers"
          onClick={() => {
            if (open()) close();
            else {
              input.focus();
              setOpen(true);
            }
          }}
        >
          ▾
        </button>
        <div
          id="market-symbol-menu"
          class="symbol-menu"
          classList={{ hidden: !open() }}
          role="listbox"
        >
          <For
            each={matches()}
            fallback={
              <div class="symbol-empty">No listed match — you can still add the typed ticker</div>
            }
          >
            {(option, index) => (
              <button
                type="button"
                id={`market-symbol-option-${index()}`}
                class="symbol-option"
                classList={{ highlighted: index() === highlighted() }}
                role="option"
                aria-selected={index() === highlighted()}
                onPointerDown={(event) => {
                  event.preventDefault();
                  select(option);
                }}
              >
                <span class="symbol-option-ticker">{option.symbol}</span>
                <span class="symbol-option-label">{option.label}</span>
              </button>
            )}
          </For>
        </div>
      </div>
      <button class="chart-add" onClick={add}>
        Add row
      </button>
    </div>
  );
}
