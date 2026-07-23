// Orchestrates the 11-step run (§10). Returns the ranked top-N rows.
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

function isCraftable(r: Recipe, ratings: Map<string, number>, unlocked: Set<number>): boolean {
  const haveDiscipline = r.disciplines.some(
    (d) => (ratings.get(d) ?? 0) >= r.min_rating,
  );
  if (!haveDiscipline) return false;
  return unlocked.has(r.id) || r.flags.includes("AutoLearned");
}

export async function run(): Promise<RoiRow[]> {
  // 1-2. Account state + recipe universe -> craftable-now set.
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
  const craftable = allRecipes.filter((r) => isCraftable(r, ratings, unlocked));
  console.log(`craftable_now=${craftable.length}`);

  // craftMap: output item id -> craftable recipes producing it (for recursive crafting).
  const craftMap = new Map<number, Recipe[]>();
  for (const r of craftable) {
    const arr = craftMap.get(r.output_item_id);
    if (arr) arr.push(r);
    else craftMap.set(r.output_item_id, [r]);
  }

  // 3. Full id set needing prices = every output + every ingredient of the craftable set.
  const priceIds = new Set<number>();
  for (const r of craftable) {
    priceIds.add(r.output_item_id);
    for (const ing of r.ingredients) priceIds.add(ing.item_id);
  }

  // 4. Bulk TP prices + velocity.
  const tp = await fetchTpData([...priceIds]);
  console.log(`priced_items=${tp.size}/${priceIds.size}`);

  // 5. coin-vendor table is bundled (imported in cost model); owned drop-only mats join it as free leaves.
  const model: CostModel = { tp, craftMap, freeMatIds: ownedFreeMats };

  // 6-8. Cost, ROI, gates.
  const memoInstant = new Map<number, number | null>();
  const passing: RoiRow[] = [];
  let scored = 0;
  for (const r of craftable) {
    const s = scoreRecipe(model, r, memoInstant);
    if (!s) continue;
    scored++;
    if (s.passes) passing.push(s.row);
  }
  console.log(`scored=${scored} passing_gates=${passing.length}`);

  // 9. Sort by primary ROI desc, take top-N.
  passing.sort((a, b) => b.roi_pct - a.roi_pct);
  const top = passing.slice(0, config.topN);

  // Resolve output item names for the top-N only (for gw2efficiency search links).
  const names = await fetchItemNames([...new Set(top.map((r) => r.output_item_id))]);
  for (const r of top) r.output_item_name = names.get(r.output_item_id) ?? "";

  return top;
}
