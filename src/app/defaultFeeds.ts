import { idToColor } from "../data/events/color.ts";
import type { RssFeed } from "../domain.ts";

export const DEFAULT_FEEDS: readonly RssFeed[] = [
  {
    id: "reuters",
    source: "Reuters",
    url: "https://www.reutersagency.com/feed/?best-top-news&post_type=best",
    color: idToColor(0),
    enabled: true,
  },
  {
    id: "aljazeera",
    source: "Al Jazeera",
    url: "https://www.aljazeera.com/xml/rss/all.xml",
    color: idToColor(1),
    enabled: true,
  },
  {
    id: "bbc",
    source: "BBC World",
    url: "http://feeds.bbci.co.uk/news/world/rss.xml",
    color: idToColor(2),
    enabled: true,
  },
  {
    id: "yahoo",
    source: "Yahoo World",
    url: "https://news.yahoo.com/rss/world",
    color: idToColor(3),
    enabled: true,
  },
  {
    id: "nyt",
    source: "NYT World",
    url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    color: idToColor(4),
    enabled: true,
  },
];
