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
  readonly onRemove: (feed: RssFeed) => void;
}

export function FeedList(props: FeedListProps) {
  return (
    <div class={styles.list} aria-label="News feeds">
      <For each={props.feeds}>
        {(feed) => (
          <div class={styles.chip} classList={{ [styles.chipDisabled!]: !feed.enabled }}>
            <button
              type="button"
              class={styles.toggle}
              aria-pressed={feed.enabled}
              title={feed.enabled ? `Hide ${feed.source}` : `Show ${feed.source}`}
              onClick={() => props.onToggle(feed)}
            >
              <span class={styles.swatch} style={{ background: feed.color }} aria-hidden="true" />
              <span class={styles.name}>{feed.source}</span>
            </button>
            <button
              type="button"
              class={styles.remove}
              title={`Remove ${feed.source}`}
              aria-label={`Remove ${feed.source}`}
              onClick={() => props.onRemove(feed)}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
