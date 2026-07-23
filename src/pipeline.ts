// Orchestrates the 11-step run (§10). Returns known + learnable ranked rows.
import { config } from "./config.ts";
import {
  fetchAllRecipeIds,
  fetchDisciplineRatings,
  fetchItemNames,
  fetchOwnedDropOnlyMats,
  fetchRecipes,
  fetchUnlockedRecipeIds,
  type Recipe,
} from "./gw2api.ts";
import { fetchTpData } from "./datawars.ts";
import type { CostModel } from "./cost.ts";
import { scoreRecipe, type RoiRow } from "./roi.ts";

// Disciplines are trained high enough to make this recipe (ignores whether it's learned yet).
function disciplineOk(r: Recipe, ratings: Map<string, number>): boolean {
  return r.disciplines.some((d) => (ratings.get(d) ?? 0) >= r.min_rating);
}

// Already known: unlocked via discovery/sheet, or auto-learned at the required rating.
function isKnown(r: Recipe, unlocked: Set<number>): boolean {
  return unlocked.has(r.id) || r.flags.includes("AutoLearned");
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

export interface RunResult {
  // recipes the account can craft right now (already known), passing the gates
  known: RoiRow[];
  // recipes the disciplines qualify for but that aren't learned yet, passing the gates
  learnable: RoiRow[];
}

export async function run(): Promise<RunResult> {
  // 1-2. Account state + recipe universe.
  const [ratings, unlocked, allIds, ownedFreeMats] = await Promise.all([
    fetchDisciplineRatings(),
    fetchUnlockedRecipeIds(),
    fetchAllRecipeIds(),
    fetchOwnedDropOnlyMats(),
  ]);
  console.log(
    `disciplines=${[...ratings].map(([d, r]) => `${d}:${r}`).join(",")} ` +
      `unlocked=${unlocked.size} total_recipes=${allIds.length} ` +
      `owned_free_mats=${ownedFreeMats.size}`,
  );

  const allRecipes = await fetchRecipes(allIds);

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
  const tp = await fetchTpData([...priceIds]);
  console.log(`priced_items=${tp.size}/${priceIds.size}`);

  // 5. Cost models. Known-table costing may only craft KNOWN intermediates; the learnable
  // table lets chains resolve through any qualified recipe (best-case for a recipe to learn).
  const freeMatIds = ownedFreeMats;
  const modelKnown: CostModel = { tp, craftMap: toCraftMap(known), freeMatIds };
  const modelAll: CostModel = { tp, craftMap: toCraftMap(qualified), freeMatIds };

  // 6-8. Cost, ROI, gates for each set.
  const passKnown: RoiRow[] = [];
  let scoredKnown = 0;
  const memoKnown = new Map<number, number | null>();
  for (const r of known) {
    const s = scoreRecipe(modelKnown, r, memoKnown);
    if (!s) continue;
    scoredKnown++;
    if (s.passes) passKnown.push(s.row);
  }

  const passLearn: RoiRow[] = [];
  let scoredLearn = 0;
  const memoLearn = new Map<number, number | null>();
  for (const r of learnable) {
    const s = scoreRecipe(modelAll, r, memoLearn);
    if (!s) continue;
    scoredLearn++;
    if (s.passes) {
      s.row.learn_method = learnMethod(r);
      passLearn.push(s.row);
    }
  }
  console.log(
    `known: scored=${scoredKnown} passing=${passKnown.length} | ` +
      `learnable: scored=${scoredLearn} passing=${passLearn.length}`,
  );

  // 9. Rank + take top-N. Known by ROI; learnable free-first (DISCOVER before BUY), then ROI.
  passKnown.sort((a, b) => b.roi_pct - a.roi_pct);
  passLearn.sort((a, b) => {
    if (a.learn_method !== b.learn_method) return a.learn_method === "DISCOVER" ? -1 : 1;
    return b.roi_pct - a.roi_pct;
  });
  const topKnown = passKnown.slice(0, config.topN);
  const topLearn = passLearn.slice(0, config.topN);

  // Resolve output item names for both top-N sets (gw2efficiency + wiki links).
  const names = await fetchItemNames([
    ...new Set([...topKnown, ...topLearn].map((r) => r.output_item_id)),
  ]);
  for (const r of [...topKnown, ...topLearn]) {
    r.output_item_name = names.get(r.output_item_id) ?? "";
  }

  return { known: topKnown, learnable: topLearn };
}
