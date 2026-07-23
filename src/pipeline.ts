// Orchestrates the 11-step run (§10). Returns the ranked top-N rows.
import { config } from "./config.ts";
import {
  fetchAllRecipeIds,
  fetchDisciplineRatings,
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
  const [ratings, unlocked, allIds] = await Promise.all([
    fetchDisciplineRatings(),
    fetchUnlockedRecipeIds(),
    fetchAllRecipeIds(),
  ]);
  console.log(
    `disciplines=${[...ratings].map(([d, r]) => `${d}:${r}`).join(",")} ` +
      `unlocked=${unlocked.size} total_recipes=${allIds.length}`,
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

  // 5. coin-vendor table is bundled (imported in cost model).
  const model: CostModel = { tp, craftMap };

  // 6-8. Cost, ROI, gates.
  const memoInstant = new Map<number, number | null>();
  const memoOptimal = new Map<number, number | null>();
  const passing: RoiRow[] = [];
  let scored = 0;
  for (const r of craftable) {
    const s = scoreRecipe(model, r, memoInstant, memoOptimal);
    if (!s) continue;
    scored++;
    if (s.passes) passing.push(s.row);
  }
  console.log(`scored=${scored} passing_gates=${passing.length}`);

  // 9. Sort by primary ROI desc, take top-N.
  passing.sort((a, b) => b.roi_pct - a.roi_pct);
  return passing.slice(0, config.topN);
}
