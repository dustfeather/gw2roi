// GW2 official API client. Rate limits: ~300 burst, 5 req/s steady, 200 ids/request, Bearer auth.
import { config } from "./config.ts";

const IDS_PER_REQ = 200;
const MIN_INTERVAL_MS = 210; // ~5 req/s with headroom

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
    if (res.status === 429) {
      const backoff = 1000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }
    if (!res.ok) throw new Error(`gw2 ${res.status} ${res.statusText} for ${url}`);
    return (await res.json()) as T;
  }
  throw new Error(`gw2 rate-limited after retries: ${url}`);
}

// Fetch every definition for a big id list, chunked by 200.
async function getBulk<T>(endpoint: string, ids: number[]): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IDS_PER_REQ) {
    const chunk = ids.slice(i, i + IDS_PER_REQ);
    const page = await getJson<T[]>(`${endpoint}?ids=${chunk.join(",")}`, false);
    out.push(...page);
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
}

// Max known rating per discipline across all account characters.
export async function fetchDisciplineRatings(): Promise<Map<string, number>> {
  const chars = await getJson<Character[]>("/v2/characters?ids=all", true);
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

export async function fetchRecipes(ids: number[]): Promise<Recipe[]> {
  return getBulk<Recipe>("/v2/recipes", ids);
}

interface Item {
  id: number;
  name: string;
}

// Item id -> display name. Used for the top-N output items only (gw2efficiency links).
export async function fetchItemNames(ids: number[]): Promise<Map<number, string>> {
  const items = await getBulk<Item>("/v2/items", ids);
  const m = new Map<number, string>();
  for (const it of items) m.set(it.id, it.name);
  return m;
}

interface AccountSlot {
  id: number | null;
  count: number;
}

// Item ids the account currently holds (material storage + bank) that are drop-only —
// flagged NoSell or AccountBound, i.e. can't be bought off the TP. These join the bundled
// free-mat table so recipes consuming mats the player already owns are no longer disqualified.
export async function fetchOwnedDropOnlyMats(): Promise<Set<number>> {
  const [materials, bank] = await Promise.all([
    getJson<AccountSlot[]>("/v2/account/materials", true),
    getJson<(AccountSlot | null)[]>("/v2/account/bank", true),
  ]);

  const held = new Set<number>();
  for (const s of [...materials, ...bank]) {
    if (s && s.id !== null && s.count > 0) held.add(s.id);
  }

  const items = await getBulk<{ id: number; flags: string[] }>("/v2/items", [...held]);
  const dropOnly = new Set<number>();
  for (const it of items) {
    if (it.flags?.includes("NoSell") || it.flags?.includes("AccountBound")) dropOnly.add(it.id);
  }
  return dropOnly;
}
