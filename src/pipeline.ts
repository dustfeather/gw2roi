// Orchestrates the 11-step run (§10). Returns known + learnable ranked rows.
import { config } from "./config.ts";
import {
  disciplineRatings,
  fetchAllRecipeIds,
  fetchCharacters,
  fetchHeldMats,
  fetchItems,
  fetchRecipes,
  fetchUnlockedRecipeIds,
  type Item,
  type Recipe,
} from "./gw2api.ts";
import { fetchTpData } from "./datawars.ts";
import type { CostModel } from "./cost.ts";
import { scoreRecipe, type RoiRow } from "./roi.ts";
import { phase } from "./timing.ts";
import { ensureDefCache, loadDefs, saveDefs, stalestDefIds } from "./db.ts";

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

// Every live recipe definition, served from the Postgres cache and topped up from the API.
//
// Only two sets are ever fetched: ids the cache has never seen (correctness — a missing
// definition would silently drop a recipe from the board), and an oldest-first refresh slice
// sized by RECIPE_REFRESH_PER_RUN (freshness — definitions change on game patches). A warm
// cache therefore costs ~3 requests an hour instead of 66, and the request volume no longer
// scales with how long the run takes.
//
// Definitions land in the cache chunk by chunk, so a cold start that runs out of time still
// banks its progress: the retry picks up where it stopped rather than re-fetching from zero.
async function loadRecipeUniverse(allIds: number[]): Promise<Recipe[]> {
  const cached = await topUpDefCache<Recipe>("recipe_defs", allIds, fetchRecipes, "recipes");
  // Ids the API declined to return (retired mid-run, or a chunk that failed) simply stay
  // absent — allIds is the universe, `cached` is what we can actually score.
  return allIds.map((id) => cached.get(id)).filter((r): r is Recipe => r !== undefined);
}

// Item definitions for the whole crafting closure: names for the board's links and flags for
// the drop-only test. ~5.7k ids, cached exactly like recipes.
async function loadItemDefs(ids: number[]): Promise<Map<number, Item>> {
  return topUpDefCache<Item>("item_defs", ids, fetchItems, "items");
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
async function topUpDefCache<T extends { id: number }>(
  table: "recipe_defs" | "item_defs",
  allIds: number[],
  fetchFn: (ids: number[], onPage?: (page: T[]) => Promise<void>) => Promise<T[]>,
  label: string,
): Promise<Map<number, T>> {
  await ensureDefCache(table);
  const cached = await loadDefs<T>(table, allIds);

  const missing = allIds.filter((id) => !cached.has(id));
  const refresh = await stalestDefIds(table, allIds, config.recipeRefreshPerRun);
  // A missing id is never also a refresh candidate (refresh only returns cached rows), so
  // the two sets are already disjoint.
  const toFetch = [...missing, ...refresh];

  if (toFetch.length > 0) {
    const fetched = await fetchFn(toFetch, (page) => saveDefs(table, page));
    for (const d of fetched) cached.set(d.id, d);
  }
  console.log(
    `${label}: cached=${allIds.length - missing.length}/${allIds.length} ` +
      `fetched_new=${missing.length} refreshed=${refresh.length}`,
  );
  return cached;
}

export interface RunResult {
  // recipes the account can craft right now (already known), passing the gates
  known: RoiRow[];
  // recipes the disciplines qualify for but that aren't learned yet, passing the gates
  learnable: RoiRow[];
}

export async function run(): Promise<RunResult> {
  // 1-2. Account state + recipe universe. One /v2/characters read feeds both the discipline
  // ratings and the bag contents below, so held stock costs nothing extra.
  const [chars, unlocked, allIds] = await phase("account", () =>
    Promise.all([fetchCharacters(), fetchUnlockedRecipeIds(), fetchAllRecipeIds()]),
  );
  const ratings = disciplineRatings(chars);
  const held = await phase("account", () => fetchHeldMats(chars));
  console.log(
    `disciplines=${[...ratings].map(([d, r]) => `${d}:${r}`).join(",")} ` +
      `unlocked=${unlocked.size} total_recipes=${allIds.length} held_mats=${held.size}`,
  );

  const allRecipes = await phase("recipes", () => loadRecipeUniverse(allIds));

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
  const tp = await phase("tp_prices", () => fetchTpData([...priceIds]));
  console.log(`priced_items=${tp.size}/${priceIds.size}`);

  // Item definitions for the crafting closure plus everything held. Held ids are included
  // even when nothing crafts with them: the drop-only test below reads their flags, and a
  // held item outside the closure (gear, junk) simply never matches an ingredient.
  const items = await phase("item_defs", () =>
    loadItemDefs([...new Set([...priceIds, ...held.keys()])]),
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
  // Each set also gets a `creditOwned` twin that prices held stock at 0 coin, feeding the
  // out-of-pocket / net_profit figures (§5). Four models, four memos — never share one.
  const ownedMats = dropOnly;
  const heldMats = held;
  const knownMap = toCraftMap(known);
  const allMap = toCraftMap(qualified);
  const modelKnown: CostModel = { tp, craftMap: knownMap, ownedMats, heldMats };
  const modelAll: CostModel = { tp, craftMap: allMap, ownedMats, heldMats };
  const modelKnownOwned: CostModel = { ...modelKnown, creditOwned: true };
  const modelAllOwned: CostModel = { ...modelAll, creditOwned: true };

  // 6-8. Cost, ROI, gates for each set.
  const passKnown: RoiRow[] = [];
  let scoredKnown = 0;
  const memoKnown = new Map<string, number | null>();
  const memoKnownOwned = new Map<string, number | null>();
  await phase("score_known", () => {
    for (const r of known) {
      const s = scoreRecipe(modelKnown, modelKnownOwned, r, memoKnown, memoKnownOwned);
      if (!s) continue;
      scoredKnown++;
      if (s.passes) passKnown.push(s.row);
    }
  });

  const passLearn: RoiRow[] = [];
  let scoredLearn = 0;
  const memoLearn = new Map<string, number | null>();
  const memoLearnOwned = new Map<string, number | null>();
  await phase("score_learnable", () => {
    for (const r of learnable) {
      const s = scoreRecipe(modelAll, modelAllOwned, r, memoLearn, memoLearnOwned);
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
  const topKnown = passKnown.slice(0, config.topN);
  const topLearn = passLearn.slice(0, config.topN);

  // Output item names for both top-N sets (gw2efficiency + wiki links). Served from the item
  // cache loaded above — this used to be its own /v2/items call for the top-N ids alone.
  for (const r of [...topKnown, ...topLearn]) {
    r.output_item_name = items.get(r.output_item_id)?.name ?? "";
  }

  return { known: topKnown, learnable: topLearn };
}
