// D1 (SQLite) schema, declared once and imported by both Workers — the cron Worker writes it,
// the board reads it. Replaces the inline `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … IF NOT
// EXISTS` DDL that used to run at the start of every hourly Postgres run: `drizzle-kit generate`
// turns this file into numbered SQL under `drizzle/`, and `wrangler d1 migrations apply` keeps a
// ledger of what has actually been applied. Idempotency is no longer the mechanism.
//
// Column NAMES stay snake_case and identical to the Postgres originals, so the cutover CSV
// import (§7) lines up column-for-column and the row types drop straight into the existing
// RoiRow shape. TS property names match the column names for the same reason.
//
// Type mapping from Postgres (§4):
//   bigint (money, ids)  -> integer   — coin values and txn ids are far inside 2^53
//   double precision     -> real
//   jsonb                -> text      — JSON.parse on read
//   timestamptz          -> integer epoch MILLISECONDS (Drizzle `timestamp_ms`)
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Every run stamps its rows with the same wall clock; SQLite has no `now()` for a DEFAULT that
// returns ms, so multiply the second-resolution `unixepoch()`.
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

// Latest-only board: DELETE + chunked INSERT per run, one transaction. No history, so every
// row in the table shares an `updated_at` — which is why the board carries no time filter.
export const craftRoi = sqliteTable("craft_roi", {
  recipe_id: integer("recipe_id").primaryKey(),
  output_item_id: integer("output_item_id").notNull().default(0),
  output_item_name: text("output_item_name").notNull().default(""),
  output_item_count: integer("output_item_count").notNull(),

  // Market-true economics, per single output item: instant-buy every ingredient, list the
  // output. The gates (§6) judge these and only these.
  craft_cost: integer("craft_cost").notNull(),
  list_revenue: integer("list_revenue").notNull(),
  profit: integer("profit").notNull(),
  roi_pct: real("roi_pct").notNull(),

  // Owned-stock discount (§5): the same plan re-costed against what the account already holds.
  // `net_profit` is the board's rank key.
  out_of_pocket: integer("out_of_pocket").notNull().default(0),
  owned_value: integer("owned_value").notNull().default(0),
  net_profit: integer("net_profit").notNull().default(0),
  net_roi_pct: real("net_roi_pct").notNull().default(0),

  instant_sell_revenue: integer("instant_sell_revenue").notNull(),
  sell_price: integer("sell_price").notNull(),
  buy_price: integer("buy_price").notNull(),
  sell_quantity: integer("sell_quantity").notNull(),
  sell_sold_day: integer("sell_sold_day").notNull(),
  days_to_sell: real("days_to_sell").notNull(),
  updated_at: updatedAt(),
});

// Qualified-but-not-yet-known recipes. Same shape as craft_roi plus `learn_method`
// ('DISCOVER' = free via the discovery panel, 'BUY' = needs a purchased recipe sheet).
export const craftRoiLearnable = sqliteTable("craft_roi_learnable", {
  recipe_id: integer("recipe_id").primaryKey(),
  output_item_id: integer("output_item_id").notNull().default(0),
  output_item_name: text("output_item_name").notNull().default(""),
  output_item_count: integer("output_item_count").notNull(),
  learn_method: text("learn_method").notNull().default(""),

  craft_cost: integer("craft_cost").notNull(),
  list_revenue: integer("list_revenue").notNull(),
  profit: integer("profit").notNull(),
  roi_pct: real("roi_pct").notNull(),

  out_of_pocket: integer("out_of_pocket").notNull().default(0),
  owned_value: integer("owned_value").notNull().default(0),
  net_profit: integer("net_profit").notNull().default(0),
  net_roi_pct: real("net_roi_pct").notNull().default(0),

  instant_sell_revenue: integer("instant_sell_revenue").notNull(),
  sell_price: integer("sell_price").notNull(),
  buy_price: integer("buy_price").notNull(),
  sell_quantity: integer("sell_quantity").notNull(),
  sell_sold_day: integer("sell_sold_day").notNull(),
  days_to_sell: real("days_to_sell").notNull(),
  updated_at: updatedAt(),
});

// Accumulate-only (insert-or-ignore by id) so history survives past the API's ~90-day window.
export const tpTransactions = sqliteTable("tp_transactions", {
  id: integer("id").primaryKey(),
  item_id: integer("item_id").notNull(),
  kind: text("kind", { enum: ["buy", "sell"] }).notNull(),
  price: integer("price").notNull(), // copper per unit
  quantity: integer("quantity").notNull(),
  purchased_at: integer("purchased_at", { mode: "timestamp_ms" }).notNull(),
});

// Wallet coin snapshots, one per run. Accumulate-only and never truncated: /v2/account/wallet
// returns only the CURRENT balance, so this table is the only balance history that will ever
// exist. It also doubles as the run-duration series (one row per completed run).
export const accountBalance = sqliteTable("account_balance", {
  recorded_at: integer("recorded_at", { mode: "timestamp_ms" }).primaryKey(),
  coin: integer("coin").notNull(),
});

// Static game-data caches. Self-maintaining: the pipeline fetches ids the cache has never seen
// plus a `RECIPE_REFRESH_PER_RUN` oldest-first slice, so a game patch converges without any
// manual step. `fetched_at` is indexed because that oldest-first sort is the hot query.
export const recipeDefs = sqliteTable(
  "recipe_defs",
  {
    id: integer("id").primaryKey(),
    def: text("def").notNull(), // JSON, parsed on read
    fetched_at: integer("fetched_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("recipe_defs_fetched_at_idx").on(t.fetched_at)],
);

export const itemDefs = sqliteTable(
  "item_defs",
  {
    id: integer("id").primaryKey(),
    def: text("def").notNull(),
    fetched_at: integer("fetched_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("item_defs_fetched_at_idx").on(t.fetched_at)],
);
