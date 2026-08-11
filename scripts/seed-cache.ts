// Offline seeder for the static game-data caches (recipe_defs, item_defs).
//
// A cold cache costs a run ~67 chunked requests and roughly ten minutes, which is most of
// the pod's per-attempt deadline — survivable, because the caches bank progress per chunk and
// resume across retries, but it means a fresh database or a lost PVC degrades the board for
// an hour or two. This script pays that cost once, offline: no pod deadline, no hourly
// schedule pressing on it, and it can be re-run at will.
//
// Deliberately sourced from the official API rather than the wiki or a community mirror. The
// wiki renders the same data downstream and offers no bulk dump, so importing from it would
// add a second thing that can silently go stale without making anything more correct.
//
//   PGHOST=... PGUSER=... PGPASSWORD=... PGDATABASE=... bun run seed-cache
//
// Idempotent: re-running refreshes every definition and re-stamps fetched_at, which also
// makes it the fastest way to pull in a game patch instead of waiting out the hourly
// RECIPE_REFRESH_PER_RUN trickle. No API key needed — recipes and items are public.
import { fetchAllRecipeIds, fetchItems, fetchRecipes, type Recipe } from "../src/gw2api.ts";
import { closeDb, ensureDefCache, loadDefs, saveDefs, type DefTable } from "../src/db.ts";

// Only seed ids that are actually reachable from a recipe. The full item corpus is ~74k
// definitions (~70MB); the crafting closure — every output plus every ingredient — is ~5.7k
// (~5MB), and nothing outside it is ever priced or scored.
function craftingClosure(recipes: Recipe[]): number[] {
  const ids = new Set<number>();
  for (const r of recipes) {
    ids.add(r.output_item_id);
    for (const ing of r.ingredients) ids.add(ing.item_id);
  }
  return [...ids];
}

// `resume` skips ids already cached, so an interrupted seed continues rather than restarting.
async function seed<T extends { id: number }>(
  table: DefTable,
  ids: number[],
  fetchFn: (ids: number[], onPage?: (page: T[]) => Promise<void>) => Promise<T[]>,
  resume: boolean,
): Promise<T[]> {
  await ensureDefCache(table);
  const have = resume ? await loadDefs<T>(table, ids) : new Map<number, T>();
  const todo = ids.filter((id) => !have.has(id));
  console.log(`${table}: ${ids.length} ids, ${have.size} cached, fetching ${todo.length}`);

  let done = 0;
  const fetched = await fetchFn(todo, async (page) => {
    await saveDefs(table, page);
    done += page.length;
    if (done % 2000 < page.length) console.log(`${table}: ${done}/${todo.length}`);
  });
  return [...have.values(), ...fetched];
}

const resume = !process.argv.includes("--refresh");
if (!resume) console.log("--refresh: re-fetching every definition, ignoring what is cached");

try {
  const allIds = await fetchAllRecipeIds();
  const recipes = await seed<Recipe>("recipe_defs", allIds, fetchRecipes, resume);

  // Item ids come from the recipes, so this must run second.
  const itemIds = craftingClosure(recipes);
  await seed("item_defs", itemIds, fetchItems, resume);

  console.log(`seeded ${recipes.length} recipes + ${itemIds.length} items`);
} catch (e) {
  console.error("seed failed:", e instanceof Error ? (e.stack ?? e.message) : e);
  console.error("re-run to continue — cached chunks are kept, only the remainder is fetched");
  process.exitCode = 1;
} finally {
  await closeDb();
}
