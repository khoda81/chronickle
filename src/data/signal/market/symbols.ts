/** Symbol discovery and autocomplete for market-backed price signals. */

export interface MarketSymbol {
  readonly symbol: string;
  readonly label: string;
}

const BINANCE_EXCHANGE_INFO =
  "https://data-api.binance.vision/api/v3/exchangeInfo?symbolStatus=TRADING&showPermissionSets=false";
const NOBITEX_MARKET_STATS = "https://apiv2.nobitex.ir/market/stats";
const CORS_PROXY = "https://corsproxy.io/?url=";

export async function fetchBinanceSymbols(): Promise<readonly MarketSymbol[]> {
  const response = await fetch(BINANCE_EXCHANGE_INFO);
  if (!response.ok) throw new Error(`Binance symbols failed: ${response.status}`);
  const payload = (await response.json()) as {
    readonly symbols?: readonly {
      readonly symbol?: unknown;
      readonly baseAsset?: unknown;
      readonly quoteAsset?: unknown;
      readonly status?: unknown;
    }[];
  };
  if (!Array.isArray(payload.symbols)) throw new Error("Binance symbols returned no symbol list");
  return payload.symbols
    .flatMap((entry): MarketSymbol[] => {
      if (
        entry.status !== "TRADING" ||
        typeof entry.symbol !== "string" ||
        typeof entry.baseAsset !== "string" ||
        typeof entry.quoteAsset !== "string"
      ) {
        return [];
      }
      return [{ symbol: entry.symbol, label: `${entry.baseAsset} / ${entry.quoteAsset}` }];
    })
    .sort(compareMarketSymbols);
}

export async function fetchNobitexSymbols(
  proxy: string = CORS_PROXY,
): Promise<readonly MarketSymbol[]> {
  const response = await fetch(`${proxy}${encodeURIComponent(NOBITEX_MARKET_STATS)}`);
  if (!response.ok) throw new Error(`Nobitex symbols failed: ${response.status}`);
  const payload = (await response.json()) as { readonly stats?: unknown };
  if (payload.stats === null || typeof payload.stats !== "object") {
    throw new Error("Nobitex symbols returned no market map");
  }
  const symbols: MarketSymbol[] = [];
  for (const key of Object.keys(payload.stats)) {
    const parsed = parseNobitexMarketKey(key);
    if (parsed !== null) symbols.push(parsed);
  }
  if (symbols.length === 0) throw new Error("Nobitex symbols returned an empty market map");
  return symbols.sort(compareMarketSymbols);
}

export function parseNobitexMarketKey(key: string): MarketSymbol | null {
  const [rawBase, rawQuote, ...rest] = key.trim().toUpperCase().split("-");
  if (rawBase === undefined || rawQuote === undefined || rest.length > 0) return null;
  const base = rawBase.replace(/[^A-Z0-9]/g, "");
  const apiQuote = rawQuote.replace(/[^A-Z0-9]/g, "");
  if (base.length === 0 || apiQuote.length === 0) return null;
  // The stats API historically calls the rial quote RLS while TradingView
  // candle symbols use IRT. Preserve the latter at the UI/fetcher boundary.
  const quote = apiQuote === "RLS" ? "IRT" : apiQuote;
  return { symbol: `${base}${quote}`, label: `${base} / ${quote}` };
}

export function filterMarketSymbols(
  symbols: readonly MarketSymbol[],
  query: string,
  limit = 80,
): readonly MarketSymbol[] {
  const needle = query.trim().toUpperCase();
  const matches = symbols.filter(
    entry =>
      needle.length === 0 ||
      entry.symbol.toUpperCase().includes(needle) ||
      entry.label.toUpperCase().includes(needle),
  );
  matches.sort((a, b) => {
    const aPrefix = a.symbol.toUpperCase().startsWith(needle) ? 0 : 1;
    const bPrefix = b.symbol.toUpperCase().startsWith(needle) ? 0 : 1;
    return aPrefix - bPrefix || compareMarketSymbols(a, b);
  });
  return matches.slice(0, Math.max(0, limit));
}

function compareMarketSymbols(a: MarketSymbol, b: MarketSymbol): number {
  return a.symbol.localeCompare(b.symbol);
}
