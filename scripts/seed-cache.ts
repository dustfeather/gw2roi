// Offline seeder for the static game-data caches (recipe_defs, item_defs).
//
// A cold cache costs a run ~67 chunked requests and roughly ten minutes — survivable, because
// the caches bank progress per chunk and resume across runs, but it means a fresh database
// degrades the board for an hour or two. This script pays that cost once, offline: no
// invocation deadline, no hourly schedule pressing on it, and it can be re-run at will.
//
// Deliberately sourced from the official API rather than the wiki or a community mirror. The
// wiki renders the same data downstream and offers no bulk dump, so importing from it would add
// a second thing that can silently go stale without making anything more correct.
//
// It does NOT talk to D1. It fetches into `.seed/*.jsonl` and emits `.seed/*.sql`, which
// `scripts/seed-cache.sh` then applies with `wrangler d1 execute --file`. Two reasons: wrangler
// already owns the credential path (no second token to mint for a manual script), and a file on
// disk is what makes the fetch resumable — re-running skips every id already in the JSONL, so
// an interrupted seed continues instead of restarting.
//
//   bun run seed-cache            # resume: fetch only ids not already in .seed/
//   bun run seed-cache --refresh  # re-fetch every definition, ignoring what is on disk
//
// No API key needed — recipes and items are public endpoints.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildConfig, createGw2Client, type Item, type Recipe } from "@gw2/core";

const OUT_DIR = new URL("../.seed/", import.meta.url).pathname;

// Only public endpoints are used, but buildConfig requires a key — pass a placeholder rather
// than making the caller find one.
const cfg = buildConfig({
  ...process.env,
  ARENA_NET_KEY: process.env.ARENA_NET_KEY || "unused-public-endpoints-only",
});
const api = createGw2Client(cfg);

// D1 caps a SQL statement at 100 KB. Item definitions average ~950 bytes, so 50 rows a
// statement stays well inside it even for the fattest ones.
const ROWS_PER_STATEMENT = 50;

function jsonlPath(table: string): string {
  return `${OUT_DIR}${table}.jsonl`;
}

function sqlPath(table: string): string {
  return `${OUT_DIR}${table}.sql`;
}

// Definitions already on disk from an earlier (possibly interrupted) run.
function readBanked<T extends { id: number }>(table: string): Map<number, T> {
  const out = new Map<number, T>();
  const path = jsonlPath(table);
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    const def = JSON.parse(line) as T;
    out.set(def.id, def);
  }
  return out;
}

async function fetchInto<T extends { id: number }>(
  table: string,
  ids: number[],
  fetchFn: (ids: number[], onPage?: (page: T[]) => Promise<void>) => Promise<T[]>,
  refresh: boolean,
): Promise<Map<number, T>> {
  const banked = refresh ? new Map<number, T>() : readBanked<T>(table);
  if (refresh) writeFileSync(jsonlPath(table), "");
  const todo = ids.filter((id) => !banked.has(id));
  console.log(`${table}: ${ids.length} ids, ${banked.size} on disk, fetching ${todo.length}`);

  let done = 0;
  await fetchFn(todo, async (page) => {
    // Appended per page, so an interrupted seed keeps everything it already paid for.
    appendFileSync(jsonlPath(table), page.map((d) => JSON.stringify(d)).join("\n") + "\n");
    for (const d of page) banked.set(d.id, d);
    done += page.length;
    if (done % 2000 < page.length) console.log(`${table}: ${done}/${todo.length}`);
  });
  return banked;
}

// Multi-row upserts with INLINE values, not bound parameters: `wrangler d1 execute --file`
// takes plain SQL, and D1's 100-bound-parameter cap would otherwise force 33-row statements.
function writeSql<T extends { id: number }>(table: string, defs: Map<number, T>): void {
  const rows = [...defs.values()].sort((a, b) => a.id - b.id);
  const parts: string[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const values = rows
      .slice(i, i + ROWS_PER_STATEMENT)
      .map((d) => `(${d.id},'${JSON.stringify(d).replaceAll("'", "''")}',(unixepoch()*1000))`)
      .join(",");
    parts.push(
      `INSERT INTO ${table} (id, def, fetched_at) VALUES ${values} ` +
        `ON CONFLICT(id) DO UPDATE SET def=excluded.def, fetched_at=excluded.fetched_at;`,
    );
  }
  writeFileSync(sqlPath(table), parts.join("\n") + "\n");
  console.log(`${table}: wrote ${rows.length} rows as ${parts.length} statements -> ${sqlPath(table)}`);
}

// Only seed ids that are actually reachable from a recipe. The full item corpus is ~74k
// definitions (~70MB); the crafting closure — every output plus every ingredient — is ~14k,
// and nothing outside it is ever priced or scored.
function craftingClosure(recipes: Recipe[]): number[] {
  const ids = new Set<number>();
  for (const r of recipes) {
    ids.add(r.output_item_id);
    for (const ing of r.ingredients) ids.add(ing.item_id);
  }
  return [...ids];
}

const refresh = process.argv.includes("--refresh");
if (refresh) console.log("--refresh: re-fetching every definition, ignoring what is on disk");

mkdirSync(OUT_DIR, { recursive: true });

try {
  const allIds = await api.fetchAllRecipeIds();
  const recipes = await fetchInto<Recipe>("recipe_defs", allIds, api.fetchRecipes, refresh);
  writeSql("recipe_defs", recipes);

  // Item ids come from the recipes, so this must run second.
  const itemIds = craftingClosure([...recipes.values()]);
  const items = await fetchInto<Item>("item_defs", itemIds, api.fetchItems, refresh);
  writeSql("item_defs", items);

  console.log(`seeded ${recipes.size} recipes + ${items.size} items — apply with seed-cache.sh`);
} catch (e) {
  console.error("seed failed:", e instanceof Error ? (e.stack ?? e.message) : e);
  console.error("re-run to continue — everything already fetched is kept in .seed/");
  process.exitCode = 1;
}
