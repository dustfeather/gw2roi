// Postgres sink. Latest-only: TRUNCATE + INSERT each run (single replica, no history).
import pg from "pg";
import { config } from "./config.ts";
import type { RoiRow } from "./roi.ts";
import type { TpTxn } from "./gw2api.ts";

const { Pool } = pg;

const pool = new Pool(
  config.databaseUrl
    ? { connectionString: config.databaseUrl }
    : {
        host: config.pg.host,
        port: config.pg.port,
        user: config.pg.user,
        password: config.pg.password,
        database: config.pg.database,
      },
);

// Shared copper -> "Xg Ys Zc" formatter so panel SQL stays DRY (one call, not a
// repeated div/mod expression per money column).
const FMT_DDL = `
CREATE OR REPLACE FUNCTION fmt_coin(bigint) RETURNS text AS $$
  SELECT (CASE WHEN $1 < 0 THEN '-' ELSE '' END)
      || (abs($1) / 10000) || 'g '
      || ((abs($1) % 10000) / 100) || 's '
      || (abs($1) % 100) || 'c';
$$ LANGUAGE sql IMMUTABLE;
`;

const DDL = `
CREATE TABLE IF NOT EXISTS craft_roi (
  recipe_id            integer PRIMARY KEY,
  output_item_id       integer NOT NULL DEFAULT 0,
  output_item_name     text    NOT NULL DEFAULT '',
  output_item_count    integer NOT NULL,
  craft_cost           bigint  NOT NULL,
  list_revenue         bigint  NOT NULL,
  profit               bigint  NOT NULL,
  roi_pct              double precision NOT NULL,
  instant_sell_revenue bigint  NOT NULL,
  sell_price          bigint  NOT NULL,
  buy_price           bigint  NOT NULL,
  sell_quantity       bigint  NOT NULL,
  sell_sold_1d        bigint  NOT NULL,
  days_to_sell        double precision NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- migrate pre-existing tables (column added 2026-07-23)
ALTER TABLE craft_roi ADD COLUMN IF NOT EXISTS output_item_name text NOT NULL DEFAULT '';
-- output_item_id back: known-table item links now open the GW2Efficiency calculator by id (2026-07-23)
ALTER TABLE craft_roi ADD COLUMN IF NOT EXISTS output_item_id integer NOT NULL DEFAULT 0;
-- rename instant_flip_floor -> instant_sell_revenue: not a flip, it's instant-sell of crafted output (2026-07-23)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'craft_roi' AND column_name = 'instant_flip_floor') THEN
    ALTER TABLE craft_roi RENAME COLUMN instant_flip_floor TO instant_sell_revenue;
  END IF;
END $$;
-- drop patient buy-order economics: optimal path removed, only instant-buy costing kept (2026-07-23)
ALTER TABLE craft_roi DROP COLUMN IF EXISTS optimal_cost;
ALTER TABLE craft_roi DROP COLUMN IF EXISTS optimal_profit;
ALTER TABLE craft_roi DROP COLUMN IF EXISTS optimal_roi_pct;
`;

// Learnable table: qualified-but-not-yet-known recipes. Same shape as craft_roi plus
// learn_method ('DISCOVER' free via discovery panel, 'BUY' needs a purchased recipe sheet).
const LEARN_DDL = `
CREATE TABLE IF NOT EXISTS craft_roi_learnable (
  recipe_id            integer PRIMARY KEY,
  output_item_id       integer NOT NULL DEFAULT 0,
  output_item_name     text    NOT NULL DEFAULT '',
  output_item_count    integer NOT NULL,
  learn_method         text    NOT NULL DEFAULT '',
  craft_cost           bigint  NOT NULL,
  list_revenue         bigint  NOT NULL,
  profit               bigint  NOT NULL,
  roi_pct              double precision NOT NULL,
  instant_sell_revenue bigint  NOT NULL,
  sell_price          bigint  NOT NULL,
  buy_price           bigint  NOT NULL,
  sell_quantity       bigint  NOT NULL,
  sell_sold_1d        bigint  NOT NULL,
  days_to_sell        double precision NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE craft_roi_learnable ADD COLUMN IF NOT EXISTS output_item_id integer NOT NULL DEFAULT 0;
`;

const COLS = [
  "recipe_id",
  "output_item_id",
  "output_item_name",
  "output_item_count",
  "craft_cost",
  "list_revenue",
  "profit",
  "roi_pct",
  "instant_sell_revenue",
  "sell_price",
  "buy_price",
  "sell_quantity",
  "sell_sold_1d",
  "days_to_sell",
] as const;

const LEARN_COLS = [
  "recipe_id",
  "output_item_id",
  "output_item_name",
  "output_item_count",
  "learn_method",
  "craft_cost",
  "list_revenue",
  "profit",
  "roi_pct",
  "instant_sell_revenue",
  "sell_price",
  "buy_price",
  "sell_quantity",
  "sell_sold_1d",
  "days_to_sell",
] as const;

function values(r: RoiRow, cols: readonly string[]): (number | string)[] {
  const all: Record<string, number | string> = {
    recipe_id: r.recipe_id,
    output_item_id: r.output_item_id,
    output_item_name: r.output_item_name,
    output_item_count: r.output_item_count,
    learn_method: r.learn_method,
    craft_cost: r.craft_cost,
    list_revenue: r.list_revenue,
    profit: r.profit,
    roi_pct: r.roi_pct,
    instant_sell_revenue: r.instant_sell_revenue,
    sell_price: r.sell_price,
    buy_price: r.buy_price,
    sell_quantity: r.sell_quantity,
    sell_sold_1d: r.sell_sold_1d,
    days_to_sell: r.days_to_sell,
  };
  return cols.map((c) => all[c] as number | string);
}

// TRUNCATE + chunked multi-row INSERT into `table` for `cols`, inside one transaction.
async function replaceTable(table: string, cols: readonly string[], rows: RoiRow[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`TRUNCATE ${table}`);
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const params: (number | string)[] = [];
      const tuples: string[] = [];
      chunk.forEach((r, ri) => {
        const base = ri * cols.length;
        tuples.push(`(${cols.map((_, ci) => `$${base + ci + 1}`).join(",")})`);
        params.push(...values(r, cols));
      });
      await client.query(
        `INSERT INTO ${table} (${cols.join(",")}) VALUES ${tuples.join(",")}`,
        params,
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Ensure both tables exist, then replace their contents (latest-only).
export async function writeRows(known: RoiRow[], learnable: RoiRow[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(FMT_DDL);
    await client.query(DDL);
    await client.query(LEARN_DDL);
  } finally {
    client.release();
  }
  await replaceTable("craft_roi", COLS, known);
  await replaceTable("craft_roi_learnable", LEARN_COLS, learnable);
}

// TP transaction history. Accumulate-only (upsert by id) so it retains data even
// after transactions age out of the API's ~90-day window.
const TXN_DDL = `
CREATE TABLE IF NOT EXISTS tp_transactions (
  id           bigint PRIMARY KEY,
  item_id      integer NOT NULL,
  kind         text    NOT NULL,
  price        bigint  NOT NULL,
  quantity     integer NOT NULL,
  purchased_at timestamptz NOT NULL
);
`;

export async function writeTransactions(txns: TpTxn[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(TXN_DDL);
    const CHUNK = 200;
    for (let i = 0; i < txns.length; i += CHUNK) {
      const chunk = txns.slice(i, i + CHUNK);
      const params: (number | string)[] = [];
      const tuples: string[] = [];
      chunk.forEach((t, ti) => {
        const b = ti * 6;
        tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
        params.push(t.id, t.item_id, t.kind, t.price, t.quantity, t.purchased);
      });
      await client.query(
        `INSERT INTO tp_transactions (id, item_id, kind, price, quantity, purchased_at)
         VALUES ${tuples.join(",")} ON CONFLICT (id) DO NOTHING`,
        params,
      );
    }
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
