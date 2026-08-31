// D1 sink + read helpers, over Drizzle. Latest-only for the two ROI tables (DELETE + INSERT
// each run), accumulate-only for `tp_transactions` and `account_balance`.
//
// Two D1 limits shape everything here:
//   - 100 bound parameters per QUERY. `craft_roi` binds 18 columns a row, so a multi-row
//     INSERT fits 5 rows (90 params). `craft_roi_learnable` binds 19, also 5 rows.
//   - `db.batch()` runs its statements as ONE implicit transaction, and the per-query limits
//     apply to each statement inside it. So the DELETE and every INSERT for a table go in a
//     single batch: the board is never observed half-written.
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import type { RoiRow } from "./roi.ts";
import type { TpTxn } from "./gw2api.ts";
import * as schema from "./schema.ts";
import { accountBalance, craftRoi, craftRoiLearnable, itemDefs, recipeDefs, tpTransactions } from "./schema.ts";

export * from "./schema.ts";

export type Db = DrizzleD1Database<typeof schema>;

// Bind a Drizzle client to a D1 binding. Per invocation, never at module scope: `env` does not
// exist at global scope, and the Worker's 1 s startup budget is not the place to do setup.
export function createDb(d1: D1Database): Db {
  return drizzle(d1, { schema });
}

type Stmt = Parameters<Db["batch"]>[0][number];

// Submit statements as batches of at most `perBatch`. Each batch is its own transaction, so
// callers that need atomicity must fit their statements into ONE call (see writeRows).
async function runBatch(db: Db, stmts: Stmt[], perBatch = 25): Promise<void> {
  for (let i = 0; i < stmts.length; i += perBatch) {
    const chunk = stmts.slice(i, i + perBatch);
    if (chunk.length === 0) continue;
    await db.batch(chunk as [Stmt, ...Stmt[]]);
  }
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

// `updated_at` is deliberately not bound: it has a DDL default, so leaving it out costs no
// parameter and still stamps every row of a run with one clock.
function knownValues(r: RoiRow): typeof craftRoi.$inferInsert {
  return {
    recipe_id: r.recipe_id,
    output_item_id: r.output_item_id,
    output_item_name: r.output_item_name,
    output_item_count: r.output_item_count,
    craft_cost: r.craft_cost,
    list_revenue: r.list_revenue,
    profit: r.profit,
    roi_pct: r.roi_pct,
    out_of_pocket: r.out_of_pocket,
    owned_value: r.owned_value,
    net_profit: r.net_profit,
    net_roi_pct: r.net_roi_pct,
    instant_sell_revenue: r.instant_sell_revenue,
    sell_price: r.sell_price,
    buy_price: r.buy_price,
    sell_quantity: r.sell_quantity,
    sell_sold_day: r.sell_sold_day,
    days_to_sell: r.days_to_sell,
  };
}

function learnableValues(r: RoiRow): typeof craftRoiLearnable.$inferInsert {
  return { ...knownValues(r), learn_method: r.learn_method };
}

// Replace both ROI tables (latest-only). One batch per table: SQLite has no TRUNCATE, so this
// is DELETE + chunked multi-row INSERT, and the batch is what makes the pair atomic.
export async function writeRows(db: Db, known: RoiRow[], learnable: RoiRow[]): Promise<void> {
  // 18 bound columns -> 5 rows (90 params) is the largest INSERT under D1's 100-param cap.
  const ROWS_PER_INSERT = 5;

  const knownStmts: Stmt[] = [db.delete(craftRoi)];
  for (const part of chunk(known.map(knownValues), ROWS_PER_INSERT)) {
    knownStmts.push(db.insert(craftRoi).values(part));
  }
  await db.batch(knownStmts as [Stmt, ...Stmt[]]);

  const learnStmts: Stmt[] = [db.delete(craftRoiLearnable)];
  for (const part of chunk(learnable.map(learnableValues), ROWS_PER_INSERT)) {
    learnStmts.push(db.insert(craftRoiLearnable).values(part));
  }
  await db.batch(learnStmts as [Stmt, ...Stmt[]]);
}

// Transaction ids already banked. The history endpoints page newest-first over a ~90-day
// window and were the largest remaining request block in a run (~10 of ~22); since a
// completed transaction never changes, everything before the first id we already hold is
// known and does not need re-reading. Paging stops there instead of walking all ten pages.
export async function knownTransactionIds(db: Db): Promise<Set<number>> {
  const rows = await db.select({ id: tpTransactions.id }).from(tpTransactions);
  return new Set(rows.map((r) => r.id));
}

export async function writeTransactions(db: Db, txns: TpTxn[]): Promise<void> {
  if (txns.length === 0) return;
  // 6 bound columns -> 16 rows (96 params).
  const stmts = chunk(txns, 16).map((part) =>
    db
      .insert(tpTransactions)
      .values(
        part.map((t) => ({
          id: t.id,
          item_id: t.item_id,
          kind: t.kind,
          price: t.price,
          quantity: t.quantity,
          purchased_at: new Date(t.purchased),
        })),
      )
      .onConflictDoNothing(),
  );
  await runBatch(db, stmts);
}

// One wallet-coin snapshot per run. The GW2 API exposes only the *current* balance, so this
// table is the only balance history that will ever exist — it is never truncated.
export async function writeBalance(db: Db, coin: number): Promise<void> {
  await db
    .insert(accountBalance)
    .values({ recorded_at: new Date(), coin })
    .onConflictDoNothing();
}

// Static game-data caches. Both tables have the same shape, so they share one set of helpers.
// `DefTable` is a closed union rather than a string: it selects a real Drizzle table object,
// so a typo cannot reach the database.
export type DefTable = "recipe_defs" | "item_defs";

const DEF_TABLES = { recipe_defs: recipeDefs, item_defs: itemDefs } as const;

export interface CachedDef<T> {
  def: T;
  fetchedAt: number; // epoch ms
}

// The WHOLE cache, in one query. The old `WHERE id = ANY($1)` in 5,000-id chunks was a
// Postgres artifact: the pipeline reads essentially every row every run (13.2k recipes, 14k
// items), so filtering buys nothing — and SQLite has no array parameter, so the chunked
// equivalent would be ~270 queries against a 100-parameter cap.
//
// `fetchedAt` comes back with it because the oldest-first refresh slice is now picked in
// memory from these rows; there is no second query for it.
export async function loadDefCache<T extends { id: number }>(
  db: Db,
  table: DefTable,
): Promise<Map<number, CachedDef<T>>> {
  const t = DEF_TABLES[table];
  const rows = await db.select({ id: t.id, def: t.def, fetched_at: t.fetched_at }).from(t);
  const out = new Map<number, CachedDef<T>>();
  for (const row of rows) {
    out.set(row.id, { def: JSON.parse(row.def) as T, fetchedAt: row.fetched_at.getTime() });
  }
  return out;
}

// Upsert definitions and stamp them fresh. Called once per fetched chunk, not once per run, so
// partial progress survives a run that never reaches the end.
//
// `fetched_at` is written as a SQL expression rather than a bound value: that keeps the row at
// two bound parameters, which doubles the rows per statement (50 instead of 33) and halves the
// statement count on a cold cache.
export async function saveDefs<T extends { id: number }>(
  db: Db,
  table: DefTable,
  defs: T[],
): Promise<void> {
  if (defs.length === 0) return;
  const t = DEF_TABLES[table];
  const now = sql`(unixepoch() * 1000)`;
  const stmts = chunk(defs, 50).map((part) =>
    db
      .insert(t)
      .values(part.map((d) => ({ id: d.id, def: JSON.stringify(d), fetched_at: now })))
      .onConflictDoUpdate({
        target: t.id,
        set: { def: sql`excluded.def`, fetched_at: sql`excluded.fetched_at` },
      }),
  );
  await runBatch(db, stmts);
}
