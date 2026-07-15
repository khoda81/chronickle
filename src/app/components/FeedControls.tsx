import { X } from "lucide-solid";
import { For, createSignal } from "solid-js";
import type { RssFeed } from "../../domain.ts";
import controlStyles from "./ui/Control.module.css";
import styles from "./FeedControls.module.css";

interface FeedInputProps {
  readonly onAdd: (url: string) => Promise<boolean>;
}

export function FeedInput(props: FeedInputProps) {
  const [url, setUrl] = createSignal("");

  const add = async (): Promise<void> => {
    const value = url().trim();
    if (value.length === 0) return;
    if (await props.onAdd(value)) setUrl("");
  };

  return (
    <section class={styles.controls} aria-labelledby="feed-controls-label">
      <span id="feed-controls-label" class={controlStyles.sectionLabel}>
        News
      </span>
      <input
        class={`${controlStyles.input} ${styles.input}`}
        type="url"
        aria-label="RSS feed URL"
        placeholder="Paste RSS feed URL…"
        spellcheck={false}
        value={url()}
        onInput={(event) => setUrl(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void add();
        }}
      />
      <button type="button" class={controlStyles.button} onClick={() => void add()}>
        Add feed
      </button>
    </section>
  );
}

interface FeedListProps {
  readonly feeds: readonly RssFeed[];
  readonly onToggle: (feed: RssFeed) => void;
  readonly onRename: (feed: RssFeed, source: string) => void;
  readonly onRemove: (feed: RssFeed) => void;
}

export function FeedList(props: FeedListProps) {
  return (
    <div class={styles.list} aria-label="News feeds">
      <For each={props.feeds}>
        {(feed) => (
          <FeedChip
            feed={feed}
            onToggle={() => props.onToggle(feed)}
            onRename={(source) => props.onRename(feed, source)}
            onRemove={() => props.onRemove(feed)}
          />
        )}
      </For>
    </div>
  );
}

interface FeedChipProps {
  readonly feed: RssFeed;
  readonly onToggle: () => void;
  readonly onRename: (source: string) => void;
  readonly onRemove: () => void;
}

function FeedChip(props: FeedChipProps) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal(props.feed.source);
  let input!: HTMLInputElement;

  const beginEditing = (): void => {
    setDraft(props.feed.source);
    setEditing(true);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  };

  const finishEditing = (): void => {
    if (!editing()) return;
    const source = draft().trim();
    setEditing(false);
    if (source.length > 0 && source !== props.feed.source) props.onRename(source);
  };

  const cancelEditing = (): void => {
    setDraft(props.feed.source);
    setEditing(false);
  };

  return (
    <div class={styles.chip} classList={{ [styles.chipDisabled!]: !props.feed.enabled }}>
      <button
        type="button"
        class={styles.toggle}
        aria-pressed={props.feed.enabled}
        title={props.feed.enabled ? `Hide ${props.feed.source}` : `Show ${props.feed.source}`}
        aria-label={props.feed.enabled ? `Hide ${props.feed.source}` : `Show ${props.feed.source}`}
        onClick={props.onToggle}
      >
        <span class={styles.swatch} style={{ background: props.feed.color }} aria-hidden="true" />
      </button>
      {editing() ? (
        <input
          ref={input}
          class={styles.nameInput}
          aria-label={`Rename ${props.feed.source}`}
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onBlur={finishEditing}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              finishEditing();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelEditing();
            }
          }}
        />
      ) : (
        <button
          type="button"
          class={styles.nameButton}
          title={`Rename ${props.feed.source}`}
          onClick={beginEditing}
        >
          <span class={styles.name}>{props.feed.source}</span>
        </button>
      )}
      <button
        type="button"
        class={styles.remove}
        title={`Remove ${props.feed.source}`}
        aria-label={`Remove ${props.feed.source}`}
        onClick={props.onRemove}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  );
}
