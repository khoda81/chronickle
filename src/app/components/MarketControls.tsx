import { Combobox } from "@kobalte/core/combobox";
import { ChevronDown } from "lucide-solid";
import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import {
  PRICE_SIGNAL_SOURCES,
  priceSignalSource,
  type PriceSignalSourceId,
} from "../../data/signal/market/market.ts";
import { filterMarketSymbols, type MarketSymbol } from "../../data/signal/market/symbols.ts";
import controlStyles from "./ui/Control.module.css";
import { SelectField, type SelectOption } from "./ui/SelectField.tsx";
import styles from "./MarketControls.module.css";

interface MarketControlsProps {
  readonly onAdd: (sourceId: PriceSignalSourceId, symbol: string) => boolean;
  readonly onLoadError: (message: string) => void;
}

const SOURCE_OPTIONS: readonly SelectOption<PriceSignalSourceId>[] = PRICE_SIGNAL_SOURCES.map(
  source => ({ value: source.id, label: source.label }),
);

export function MarketControls(props: MarketControlsProps) {
  const initialSource = PRICE_SIGNAL_SOURCES[0]!;
  const [sourceId, setSourceId] = createSignal<PriceSignalSourceId>(initialSource.id);
  const [options, setOptions] = createSignal<readonly MarketSymbol[]>(initialSource.examples);
  let loadGeneration = 0;

  createEffect(
    on(sourceId, nextSourceId => {
      const source = priceSignalSource(nextSourceId);
      if (source === null) return;
      const generation = ++loadGeneration;
      setOptions(source.examples);
      void source
        .loadSymbols()
        .then(loaded => {
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

  return (
    <section class={styles.controls} aria-labelledby="market-controls-label">
      <span id="market-controls-label" class={controlStyles.sectionLabel}>
        Charts
      </span>
      <SelectField
        ariaLabel="Market source"
        value={sourceId()}
        options={SOURCE_OPTIONS}
        triggerClass={styles.sourceTrigger}
        onChange={setSourceId}
      />
      <Show when={priceSignalSource(sourceId())} keyed>
        {source => (
          <SymbolCombobox
            sourceLabel={source.label}
            initialSymbol={source.examples[0]?.symbol ?? ""}
            options={options()}
            onAdd={symbol => props.onAdd(source.id, symbol)}
          />
        )}
      </Show>
    </section>
  );
}

interface SymbolComboboxProps {
  readonly sourceLabel: string;
  readonly initialSymbol: string;
  readonly options: readonly MarketSymbol[];
  readonly onAdd: (symbol: string) => boolean;
}

function SymbolCombobox(props: SymbolComboboxProps) {
  const initialOption = () =>
    props.options.find(option => option.symbol === props.initialSymbol) ??
    ({ symbol: props.initialSymbol, label: props.initialSymbol } satisfies MarketSymbol);
  const [symbol, setSymbol] = createSignal(props.initialSymbol);
  const [open, setOpen] = createSignal(false);
  const matches = createMemo(() => filterMarketSymbols(props.options, symbol()));
  let input!: HTMLInputElement;

  const add = (): void => {
    if (props.onAdd(symbol())) input.select();
  };

  return (
    <form
      class={styles.symbolForm}
      onSubmit={event => {
        event.preventDefault();
        add();
      }}>
      <Combobox<MarketSymbol>
        class={styles.symbolRoot}
        open={open()}
        onOpenChange={setOpen}
        options={[...props.options]}
        defaultValue={initialOption()}
        optionValue="symbol"
        optionLabel="symbol"
        optionTextValue={option => `${option.symbol} ${option.label}`}
        defaultFilter={(option, inputValue) => filterMarketSymbols([option], inputValue).length > 0}
        onInputChange={setSymbol}
        onChange={option => {
          if (option !== null) setSymbol(option.symbol);
        }}
        triggerMode="focus"
        allowsEmptyCollection
        noResetInputOnBlur
        gutter={6}
        sameWidth={false}
        fitViewport
        itemComponent={itemProps => (
          <Combobox.Item item={itemProps.item} class={styles.symbolItem}>
            <Combobox.ItemLabel class={styles.symbolTicker}>
              {itemProps.item.rawValue.symbol}
            </Combobox.ItemLabel>
            <Combobox.ItemDescription class={styles.symbolLabel}>
              {itemProps.item.rawValue.label}
            </Combobox.ItemDescription>
          </Combobox.Item>
        )}>
        <Combobox.Control class={styles.symbolControl} aria-label={`${props.sourceLabel} ticker`}>
          <Combobox.Input
            ref={input}
            class={styles.symbolInput}
            placeholder="Ticker, e.g. BTCUSDT"
            onKeyDown={event => {
              // Kobalte suppresses form submission while the popup is open.
              // With no selectable match, close it so Enter submits the
              // user's free-form ticker instead.
              if (event.key === "Enter" && matches().length === 0) setOpen(false);
            }}
          />
          <Combobox.Trigger
            class={styles.symbolTrigger}
            title="Show available tickers"
            aria-label="Show available tickers">
            <Combobox.Icon class={styles.symbolIcon}>
              <ChevronDown aria-hidden="true" />
            </Combobox.Icon>
          </Combobox.Trigger>
        </Combobox.Control>
        <Combobox.Portal>
          <Combobox.Content class={styles.symbolContent}>
            <Combobox.Listbox class={styles.symbolListbox} />
            <Show when={matches().length === 0}>
              <div class={styles.symbolEmpty}>
                No listed match — the typed ticker can still be added
              </div>
            </Show>
          </Combobox.Content>
        </Combobox.Portal>
      </Combobox>
      <button type="submit" class={controlStyles.button}>
        Add row
      </button>
    </form>
  );
}
