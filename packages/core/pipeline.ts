// Orchestrates the 11-step run (§10). Returns known + learnable ranked rows.
import type { Config } from "./config.ts";
import { disciplineRatings, type Gw2Client, type Item, type Recipe } from "./gw2api.ts";
import { fetchTpData } from "./datawars.ts";
import type { CostMemo, CostModel } from "./cost.ts";
import { scoreRecipe, type RoiRow } from "./roi.ts";
import { phase } from "./timing.ts";
import { loadDefCache, saveDefs, type DefTable, type Db } from "./db.ts";

// Disciplines are trained high enough to make this recipe (ignores whether it's learned yet).
// Must actually HAVE the discipline: a missing discipline must fail even when min_rating is 0,
// otherwise every 0-rating recipe (e.g. basic Chef dishes) leaks in for untrained disciplines.
function disciplineOk(r: Recipe, ratings: Map<string, number>): boolean {
  return r.disciplines.some((d) => ratings.has(d) && ratings.get(d)! >= r.min_rating);
}

// Known = craftable without buying a recipe sheet. GW2's /v2/account/recipes only reports
// sheet (LearnedFromItem) unlocks, never discovery recipes — so we assume every discovery
// recipe is (or will be) learned on demand. Only an unowned SHEET counts as not-known.
function isKnown(r: Recipe, unlocked: Set<number>): boolean {
  return unlocked.has(r.id) || !r.flags.includes("LearnedFromItem");
}

// How a not-yet-known recipe is learned: "BUY" needs a purchased recipe sheet,
// "DISCOVER" is free via the discovery panel.
function learnMethod(r: Recipe): string {
  return r.flags.includes("LearnedFromItem") ? "BUY" : "DISCOVER";
}

function toCraftMap(recipes: Recipe[]): Map<number, Recipe[]> {
  const m = new Map<number, Recipe[]>();
  for (const r of recipes) {
    const arr = m.get(r.output_item_id);
    if (arr) arr.push(r);
    else m.set(r.output_item_id, [r]);
  }
  return m;
}

// Shared cache top-up. Only two sets are ever fetched: ids the cache has never seen
// (correctness — a missing definition silently drops a recipe from the board, or misreads an
// owned mat as tradable), and an oldest-first refresh slice sized by RECIPE_REFRESH_PER_RUN
// (freshness — definitions change on game patches). A warm cache costs a handful of requests
// an hour instead of scaling with the size of the game, and request volume no longer tracks
// how slow the API happens to be that hour.
//
// Definitions land chunk by chunk, so a cold start that runs out of time still banks its
// progress: the retry picks up where it stopped rather than re-fetching from zero.
//
// The whole cache arrives in ONE query and the refresh slice is chosen from it in memory. Under
// Postgres this was two queries with `id = ANY($1)` filters; D1 has no array parameter and a
// 100-bound-parameter cap, and the pipeline reads essentially every row anyway.
async function topUpDefCache<T extends { id: number }>(
  cfg: Config,
  db: Db,
  table: DefTable,
  allIds: number[],
  fetchFn: (ids: number[], onPage?: (page: T[]) => Promise<void>) => Promise<T[]>,
  label: string,
): Promise<Map<number, T>> {
  const cache = await loadDefCache<T>(db, table);
  const cached = new Map<number, T>();
  for (const [id, row] of cache) cached.set(id, row.def);

  const missing = allIds.filter((id) => !cached.has(id));
  const refresh = stalestDefIds(cache, allIds, cfg.recipeRefreshPerRun);
  // A missing id is never also a refresh candidate (refresh only considers cached rows), so
  // the two sets are already disjoint.
  const toFetch = [...missing, ...refresh];

  if (toFetch.length > 0) {
    const fetched = await fetchFn(toFetch, (page) => saveDefs(db, table, page));
    for (const d of fetched) cached.set(d.id, d);
  }
  console.log(
    `${label}: cached=${allIds.length - missing.length}/${allIds.length} ` +
      `fetched_new=${missing.length} refreshed=${refresh.length}`,
  );
  return cached;
}

// The `limit` cached ids whose definitions were fetched longest ago, restricted to ids that are
// still live. Retired ids are skipped so they can never wedge the head of the refresh queue and
// starve everything behind them.
function stalestDefIds(
  cache: Map<number, { fetchedAt: number }>,
  liveIds: number[],
  limit: number,
): number[] {
  if (limit <= 0) return [];
  const live: { id: number; at: number }[] = [];
  for (const id of liveIds) {
    const row = cache.get(id);
    if (row) live.push({ id, at: row.fetchedAt });
  }
  live.sort((a, b) => a.at - b.at);
  return live.slice(0, limit).map((r) => r.id);
}

export interface RunResult {
  // recipes the account can craft right now (already known), passing the gates
  known: RoiRow[];
  // recipes the disciplines qualify for but that aren't learned yet, passing the gates
  learnable: RoiRow[];
}

export async function run(cfg: Config, db: Db, api: Gw2Client): Promise<RunResult> {
  // 1-2. Account state + recipe universe. One /v2/characters read feeds both the discipline
  // ratings and the bag contents below, so held stock costs nothing extra.
  const [chars, unlocked, allIds] = await phase("account", () =>
    Promise.all([api.fetchCharacters(), api.fetchUnlockedRecipeIds(), api.fetchAllRecipeIds()]),
  );
  const ratings = disciplineRatings(chars);
  const held = await phase("account", () => api.fetchHeldMats(chars));
  console.log(
    `disciplines=${[...ratings].map(([d, r]) => `${d}:${r}`).join(",")} ` +
      `unlocked=${unlocked.size} total_recipes=${allIds.length} held_mats=${held.size}`,
  );

  // Every live recipe definition, served from the D1 cache and topped up from the API. Ids the
  // API declined to return (retired mid-run, or a chunk that failed) simply stay absent —
  // allIds is the universe, the cache is what we can actually score.
  const allRecipes = await phase("recipes", async () => {
    const cached = await topUpDefCache<Recipe>(
      cfg,
      db,
      "recipe_defs",
      allIds,
      api.fetchRecipes,
      "recipes",
    );
    return allIds.map((id) => cached.get(id)).filter((r): r is Recipe => r !== undefined);
  });

  // Two candidate sets, both bounded by trained disciplines:
  //   known     = craftable right now (primary table)
  //   learnable = qualified-but-not-learned (learnable table)
  const qualified = allRecipes.filter((r) => disciplineOk(r, ratings));
  const known = qualified.filter((r) => isKnown(r, unlocked));
  const learnable = qualified.filter((r) => !isKnown(r, unlocked));
  console.log(`qualified=${qualified.length} known=${known.length} learnable=${learnable.length}`);

  // 3. Price every output + ingredient across BOTH sets (superset = qualified closure).
  const priceIds = new Set<number>();
  for (const r of qualified) {
    priceIds.add(r.output_item_id);
    for (const ing of r.ingredients) priceIds.add(ing.item_id);
  }

  // 4. Bulk TP prices + velocity.
  const tp = await phase("tp_prices", () => fetchTpData(cfg, [...priceIds]));
  console.log(`priced_items=${tp.size}/${priceIds.size}`);

  // Item definitions for the crafting closure plus everything held: names for the board's
  // links, flags for the drop-only test. Held ids are included even when nothing crafts with
  // them — a held item outside the closure (gear, junk) simply never matches an ingredient.
  const items = await phase("item_defs", () =>
    topUpDefCache<Item>(
      cfg,
      db,
      "item_defs",
      [...new Set([...priceIds, ...held.keys()])],
      api.fetchItems,
      "items",
    ),
  );

  // Drop-only = flagged NoSell or AccountBound, i.e. can't be bought off the TP. These join
  // the bundled free-mat table so recipes consuming mats the player already owns are no
  // longer disqualified. Counts, not just ids: the cost model may only spend what's on hand.
  const dropOnly = new Map<number, number>();
  for (const [id, count] of held) {
    const flags = items.get(id)?.flags;
    if (flags?.includes("NoSell") || flags?.includes("AccountBound")) dropOnly.set(id, count);
  }
  console.log(`owned_free_mats=${dropOnly.size} held_mats=${held.size}`);

  // 5. Cost models. Known-table costing may only craft KNOWN intermediates; the learnable
  // table lets chains resolve through any qualified recipe (best-case for a recipe to learn).
  // Two models, two memos — never share one across the two, their craftMaps differ.
  //
  // The out-of-pocket figures (§5) are NOT a third and fourth model: they re-walk the plan
  // each model already chose, spending a per-recipe copy of heldMats against it. Deciding the
  // plan once is what makes the memo safe to share — an inventory that decrements as it is
  // consumed is order-dependent, so a cost keyed on (item, need) alone could not cache it.
  const ownedMats = dropOnly;
  const heldMats = held;
  const knownMap = toCraftMap(known);
  const allMap = toCraftMap(qualified);
  const modelKnown: CostModel = { tp, craftMap: knownMap, ownedMats, heldMats };
  const modelAll: CostModel = { tp, craftMap: allMap, ownedMats, heldMats };

  // 6-8. Cost, ROI, gates for each set.
  const passKnown: RoiRow[] = [];
  let scoredKnown = 0;
  const memoKnown: CostMemo = new Map();
  await phase("score_known", () => {
    for (const r of known) {
      const s = scoreRecipe(cfg, modelKnown, r, memoKnown);
      if (!s) continue;
      scoredKnown++;
      if (s.passes) passKnown.push(s.row);
    }
  });

  const passLearn: RoiRow[] = [];
  let scoredLearn = 0;
  const memoLearn: CostMemo = new Map();
  await phase("score_learnable", () => {
    for (const r of learnable) {
      const s = scoreRecipe(cfg, modelAll, r, memoLearn);
      if (!s) continue;
      scoredLearn++;
      if (s.passes) {
        s.row.learn_method = learnMethod(r);
        passLearn.push(s.row);
      }
    }
  });
  console.log(
    `known: scored=${scoredKnown} passing=${passKnown.length} | ` +
      `learnable: scored=${scoredLearn} passing=${passLearn.length}`,
  );

  // 9. Rank + take top-N by absolute NET PROFIT (copper per craft after spending held stock),
  // not ROI percent. ROI alone favours cheap crafts: a 5c -> 15c item is 200% ROI but 10c a
  // pop, while a 3g -> 4g craft is 33% ROI and worth 300x more per craft. Net rather than raw
  // profit so mats already in the bank give a recipe an edge over an otherwise-equal one.
  // Selection and display must use the same key, otherwise top-N silently picks a different
  // set than the board shows — see the ORDER BYs in k8s/grafana/dashboards/.
  // ROI is still gated on (GATE_MIN_ROI_PCT) and still displayed alongside profit.
  // Learnable stays free-first (DISCOVER before BUY), then net profit.
  passKnown.sort((a, b) => b.net_profit - a.net_profit);
  passLearn.sort((a, b) => {
    if (a.learn_method !== b.learn_method) return a.learn_method === "DISCOVER" ? -1 : 1;
    return b.net_profit - a.net_profit;
  });
  const topKnown = passKnown.slice(0, cfg.topN);
  const topLearn = passLearn.slice(0, cfg.topN);

  // Output item names for both top-N sets (gw2efficiency + wiki links). Served from the item
  // cache loaded above — this used to be its own /v2/items call for the top-N ids alone.
  for (const r of [...topKnown, ...topLearn]) {
    r.output_item_name = items.get(r.output_item_id)?.name ?? "";
  }

  return { known: topKnown, learnable: topLearn };
}
