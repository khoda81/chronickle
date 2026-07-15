import { For, createSignal } from "solid-js";
import type { RssFeed } from "../../domain.ts";

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
    <div class="feed-controls">
      <input
        class="feed-input"
        type="url"
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
      <button class="feed-add" onClick={() => void add()}>
        Add feed
      </button>
    </div>
  );
}

interface FeedListProps {
  readonly feeds: readonly RssFeed[];
  readonly onToggle: (feed: RssFeed) => void;
  readonly onRemove: (feed: RssFeed) => void;
}

export function FeedList(props: FeedListProps) {
  return (
    <div class="feed-list">
      <For each={props.feeds}>
        {(feed) => (
          <div
            class="feed-row"
            classList={{ disabled: !feed.enabled }}
            title={feed.enabled ? `Click to hide ${feed.source}` : `Click to show ${feed.source}`}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest(".feed-remove")) return;
              props.onToggle(feed);
            }}
          >
            <span class="feed-swatch" style={{ background: feed.color }} />
            <span class="feed-name">{feed.source}</span>
            <button
              class="feed-remove"
              title={`Remove ${feed.source}`}
              onClick={(event) => {
                event.stopPropagation();
                props.onRemove(feed);
              }}
            >
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
