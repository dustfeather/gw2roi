// GW2 official API client. Rate limits: ~300 burst, 5 req/s steady, 200 ids/request, Bearer auth.
import { config } from "./config.ts";

const IDS_PER_REQ = 200;
const MIN_INTERVAL_MS = 210; // ~5 req/s with headroom

// Distinguishable so a bulk `?ids=` sweep can tell "none of these ids exist" apart from a
// real failure. Every other caller sees it as a plain Error and still throws.
class Gw2NotFound extends Error {}

let lastReq = 0;
async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = lastReq + MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
}

async function getJson<T>(path: string, auth: boolean): Promise<T> {
  const url = path.startsWith("http") ? path : `${config.gw2ApiBase}${path}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    await throttle();
    const res = await fetch(url, {
      headers: auth ? { Authorization: `Bearer ${config.arenaNetKey}` } : {},
    });
    // Retry rate-limits (429), transient server errors (5xx), and the 400s ArenaNet
    // returns on authenticated account endpoints when its backend times out — the body
    // is ErrTimeout/ErrBadData, not a malformed request, so the same call succeeds later.
    // Unauthenticated 400s (bad ids) are genuine and still fail fast.
    if (res.status === 429 || res.status >= 500 || (res.status === 400 && auth)) {
      const backoff = 1000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const msg = `gw2 ${res.status} ${res.statusText} for ${url} ${body.slice(0, 200)}`;
      if (res.status === 404) throw new Gw2NotFound(msg);
      throw new Error(msg);
    }
    return (await res.json()) as T;
  }
  throw new Error(`gw2 still failing after retries (429/5xx/authed 400): ${url}`);
}

// Fetch every definition for a big id list, chunked by 200. `onPage` is awaited after each
// chunk: callers that cache use it to bank progress per chunk, so a run killed partway
// through a long id list keeps what it already paid for instead of starting over.
async function getBulk<T>(
  endpoint: string,
  ids: number[],
  onPage?: (page: T[]) => Promise<void>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IDS_PER_REQ) {
    const chunk = ids.slice(i, i + IDS_PER_REQ);
    // A bulk request whose ids only PARTLY resolve comes back 206 with the valid subset, but
    // one where NONE resolve is a 404 `all ids provided are invalid`. Recipes do reference
    // ids /v2/items never exposes (dev/unreleased entries — ~38 across the full crafting
    // closure), and once those cluster into a chunk of their own the 404 would abort the whole
    // sweep, permanently: they are dead ids, so every retry fails identically. Skip the chunk.
    // `endpoint` is a fixed literal at both call sites, so a 404 here cannot be a bad path.
    const page = await getJson<T[]>(`${endpoint}?ids=${chunk.join(",")}`, false).catch(
      (e: unknown) => {
        if (e instanceof Gw2NotFound) return [] as T[];
        throw e;
      },
    );
    out.push(...page);
    if (onPage) await onPage(page);
  }
  return out;
}

export interface Recipe {
  id: number;
  type: string;
  output_item_id: number;
  output_item_count: number;
  min_rating: number;
  disciplines: string[];
  flags: string[];
  ingredients: { item_id: number; count: number }[];
}

export interface Character {
  name: string;
  crafting?: { discipline: string; rating: number; active: boolean }[];
  // Equipped bags and their contents. Present because the API key carries the `inventories`
  // scope — this arrives in the same response as `crafting`, at no extra request.
  bags?: ({ id: number; size: number; inventory: (AccountSlot | null)[] } | null)[];
}

// One /v2/characters read serves both discipline ratings and bag contents. Kept as a single
// call deliberately: the response already contains everything, and splitting it would buy a
// second request for data we were handed the first time.
export async function fetchCharacters(): Promise<Character[]> {
  return getJson<Character[]>("/v2/characters?ids=all", true);
}

// Max known rating per discipline across all account characters.
export function disciplineRatings(chars: Character[]): Map<string, number> {
  const ratings = new Map<string, number>();
  for (const c of chars) {
    for (const cr of c.crafting ?? []) {
      const cur = ratings.get(cr.discipline) ?? 0;
      if (cr.rating > cur) ratings.set(cr.discipline, cr.rating);
    }
  }
  return ratings;
}

// Recipe ids the account has explicitly unlocked (excludes AutoLearned).
export async function fetchUnlockedRecipeIds(): Promise<Set<number>> {
  const ids = await getJson<number[]>("/v2/account/recipes", true);
  return new Set(ids);
}

// Every recipe id in the game.
export async function fetchAllRecipeIds(): Promise<number[]> {
  return getJson<number[]>("/v2/recipes", false);
}

export async function fetchRecipes(
  ids: number[],
  onPage?: (page: Recipe[]) => Promise<void>,
): Promise<Recipe[]> {
  return getBulk<Recipe>("/v2/recipes", ids, onPage);
}

// Only the fields the pipeline reads. The full /v2/items payload averages ~950 bytes an
// item; the cache stores what comes back, but nothing downstream depends on the rest.
export interface Item {
  id: number;
  name: string;
  flags?: string[];
}

// Item definitions, chunked by 200. Cached in item_defs the same way recipes are, so a warm
// run fetches only unseen ids plus a refresh slice — see loadItemDefs() in pipeline.ts.
export async function fetchItems(
  ids: number[],
  onPage?: (page: Item[]) => Promise<void>,
): Promise<Item[]> {
  return getBulk<Item>("/v2/items", ids, onPage);
}

interface AccountSlot {
  id: number | null;
  count: number;
}

export interface OwnedMats {
  // Everything the account holds, id -> units. Used only to discount the out-of-pocket
  // figure (§5); never feeds the true cost model, where pricing an owned-but-tradable mat
  // at 0 would inflate ROI.
  held: Map<number, number>;
  // The drop-only subset: flagged NoSell or AccountBound, i.e. can't be bought off the TP.
  // These join the bundled free-mat table so recipes consuming mats the player already
  // owns are no longer disqualified.
  dropOnly: Map<number, number>;
}

// Item ids + counts the account currently holds. Four places, because a mid-chain
// intermediate is exactly the thing that does NOT sit in material storage: you craft it and
// it lands in the crafting character's bags, where it stayed invisible to this bot until
// 2026-08-11. `chars` is the response already fetched for discipline ratings, so character
// bags cost no extra request; only shared inventory slots add one.
export async function fetchHeldMats(chars: Character[]): Promise<Map<number, number>> {
  const [materials, bank, shared] = await Promise.all([
    getJson<AccountSlot[]>("/v2/account/materials", true),
    getJson<(AccountSlot | null)[]>("/v2/account/bank", true),
    // Shared inventory slots. Singular `inventory` — `/v2/account/inventories` 404s, which
    // took every run down for nine hours on 2026-08-11. Optional by design: this is a
    // handful of slots enriching a discount, so a failure here degrades the held-stock
    // figure rather than losing the whole run. Storage, bank and bags are load-bearing and
    // deliberately left to throw.
    getJson<(AccountSlot | null)[]>("/v2/account/inventory", true).catch((e: unknown) => {
      console.warn(`shared inventory unavailable, continuing without it: ${String(e)}`);
      return [] as (AccountSlot | null)[];
    }),
  ]);

  // Bag contents only — the bag item itself is equipped, not stock we could consume.
  const bagSlots: (AccountSlot | null)[] = [];
  for (const c of chars) {
    for (const bag of c.bags ?? []) {
      if (bag) bagSlots.push(...(bag.inventory ?? []));
    }
  }

  // Counts, not just ids: drop-only mats can't be TP- or vendor-bought, so the cost model may
  // only spend as many as are actually on hand (§4). The same item can occupy many slots
  // across storage, bank, shared slots and several characters' bags — all of them add up.
  const held = new Map<number, number>();
  for (const s of [...materials, ...bank, ...shared, ...bagSlots]) {
    if (s && s.id !== null && s.count > 0) held.set(s.id, (held.get(s.id) ?? 0) + s.count);
  }
  return held;
}

// Current account coin balance in copper (wallet currency id 1). Needs the `wallet` scope.
// Returns null when the key lacks the scope or the wallet omits coin, so callers can skip
// writing rather than record a bogus 0 balance.
export async function fetchWalletCoin(): Promise<number | null> {
  const wallet = await getJson<{ id: number; value: number }[]>("/v2/account/wallet", true);
  return wallet.find((c) => c.id === 1)?.value ?? null;
}

export interface TpTxn {
  id: number;
  item_id: number;
  kind: "buy" | "sell";
  price: number; // copper per unit
  quantity: number;
  purchased: string; // ISO timestamp the transaction completed
}

// Completed trading-post transactions (buys + sells, ~last 90 days), paginated.
// Needs the `tradingpost` scope on the API key.
// Pass the ids already banked in tp_transactions to stop paging early. History pages come
// back newest-first and a completed transaction never changes, so the first page that adds
// nothing new means everything behind it is already stored. On a steady account that turns
// ~10 requests a run into 2 — the largest remaining block once definitions were cached.
//
// Stop on a page that yields nothing NEW rather than on the first known id: a page can
// interleave a known transaction with unseen ones, and bailing mid-page would drop them.
export async function fetchTpTransactions(known: Set<number> = new Set()): Promise<TpTxn[]> {
  const out: TpTxn[] = [];
  const kinds: { kind: "buy" | "sell"; path: string }[] = [
    { kind: "buy", path: "buys" },
    { kind: "sell", path: "sells" },
  ];
  for (const { kind, path } of kinds) {
    for (let page = 0; page < 10; page++) {
      const rows = await getJson<
        { id: number; item_id: number; price: number; quantity: number; purchased: string | null }[]
      >(`/v2/commerce/transactions/history/${path}?page=${page}&page_size=200`, true);
      let fresh = 0;
      for (const r of rows) {
        if (!r.purchased) continue; // only completed transactions
        if (known.has(r.id)) continue;
        fresh++;
        out.push({ id: r.id, item_id: r.item_id, kind, price: r.price, quantity: r.quantity, purchased: r.purchased });
      }
      if (rows.length < 200 || fresh === 0) break;
    }
  }
  return out;
}
