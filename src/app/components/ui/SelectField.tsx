import { Select } from "@kobalte/core/select";
import { Check, ChevronDown } from "lucide-solid";
import type { JSX } from "solid-js";
import surfaceStyles from "../../../styles/floatingSurface.module.css";
import styles from "./SelectField.module.css";

export interface SelectOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
}

interface SelectFieldProps<Value extends string> {
  readonly ariaLabel: string;
  readonly value: Value;
  readonly options: readonly SelectOption<Value>[];
  readonly onChange: (value: Value) => void;
  readonly class?: string;
  readonly triggerClass?: string;
  readonly valueContent?: (option: SelectOption<Value>) => JSX.Element;
  readonly itemContent?: (option: SelectOption<Value>) => JSX.Element;
}

export function SelectField<Value extends string>(props: SelectFieldProps<Value>) {
  const selectedOption = () =>
    props.options.find(option => option.value === props.value) ?? props.options[0] ?? null;

  return (
    <Select<SelectOption<Value>>
      class={`${styles.root} ${props.class ?? ""}`}
      options={[...props.options]}
      value={selectedOption()}
      optionValue="value"
      optionTextValue="label"
      onChange={option => {
        if (option !== null) props.onChange(option.value);
      }}
      itemComponent={itemProps => (
        <Select.Item item={itemProps.item} class={styles.item}>
          <Select.ItemLabel class={styles.itemLabel}>
            {props.itemContent?.(itemProps.item.rawValue) ?? itemProps.item.rawValue.label}
          </Select.ItemLabel>
          <Select.ItemIndicator class={styles.indicator}>
            <Check aria-hidden="true" />
          </Select.ItemIndicator>
        </Select.Item>
      )}
      gutter={6}
      flip
      slide
      overflowPadding={8}
      sameWidth
      fitViewport>
      <Select.Trigger
        class={`${styles.trigger} ${props.triggerClass ?? ""}`}
        aria-label={props.ariaLabel}>
        <Select.Value<SelectOption<Value>> class={styles.value}>
          {state => {
            const selected = state.selectedOption();
            return selected === undefined
              ? null
              : (props.valueContent?.(selected) ?? selected.label);
          }}
        </Select.Value>
        <Select.Icon class={styles.icon}>
          <ChevronDown aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          class={styles.content}
          classList={{ [surfaceStyles.menu!]: true, [surfaceStyles.listboxPanel!]: true }}>
          <Select.Listbox class={styles.listbox} />
        </Select.Content>
      </Select.Portal>
    </Select>
  );
}
