// Postgres sink. Latest-only: TRUNCATE + INSERT each run (single replica, no history).
import pg from "pg";
import { config } from "./config.ts";
import type { RoiRow } from "./roi.ts";

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

const DDL = `
CREATE TABLE IF NOT EXISTS craft_roi (
  recipe_id            integer PRIMARY KEY,
  output_item_name     text    NOT NULL DEFAULT '',
  output_item_count    integer NOT NULL,
  craft_cost           bigint  NOT NULL,
  list_revenue         bigint  NOT NULL,
  profit               bigint  NOT NULL,
  roi_pct              double precision NOT NULL,
  instant_sell_revenue bigint  NOT NULL,
  optimal_cost        bigint  NOT NULL,
  optimal_profit      bigint  NOT NULL,
  optimal_roi_pct     double precision NOT NULL,
  sell_price          bigint  NOT NULL,
  buy_price           bigint  NOT NULL,
  sell_quantity       bigint  NOT NULL,
  sell_sold_1d        bigint  NOT NULL,
  days_to_sell        double precision NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- migrate pre-existing tables (column added 2026-07-23)
ALTER TABLE craft_roi ADD COLUMN IF NOT EXISTS output_item_name text NOT NULL DEFAULT '';
-- drop output_item_id: Grafana keys on name now (2026-07-23)
ALTER TABLE craft_roi DROP COLUMN IF EXISTS output_item_id;
-- rename instant_flip_floor -> instant_sell_revenue: not a flip, it's instant-sell of crafted output (2026-07-23)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'craft_roi' AND column_name = 'instant_flip_floor') THEN
    ALTER TABLE craft_roi RENAME COLUMN instant_flip_floor TO instant_sell_revenue;
  END IF;
END $$;
`;

const COLS = [
  "recipe_id",
  "output_item_name",
  "output_item_count",
  "craft_cost",
  "list_revenue",
  "profit",
  "roi_pct",
  "instant_sell_revenue",
  "optimal_cost",
  "optimal_profit",
  "optimal_roi_pct",
  "sell_price",
  "buy_price",
  "sell_quantity",
  "sell_sold_1d",
  "days_to_sell",
] as const;

function values(r: RoiRow): (number | string)[] {
  return [
    r.recipe_id,
    r.output_item_name,
    r.output_item_count,
    r.craft_cost,
    r.list_revenue,
    r.profit,
    r.roi_pct,
    r.instant_sell_revenue,
    r.optimal_cost,
    r.optimal_profit,
    r.optimal_roi_pct,
    r.sell_price,
    r.buy_price,
    r.sell_quantity,
    r.sell_sold_1d,
    r.days_to_sell,
  ];
}

export async function writeRows(rows: RoiRow[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(DDL);
    await client.query("BEGIN");
    await client.query("TRUNCATE craft_roi");
    // chunked multi-row INSERT
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const params: (number | string)[] = [];
      const tuples: string[] = [];
      chunk.forEach((r, ri) => {
        const base = ri * COLS.length;
        tuples.push(`(${COLS.map((_, ci) => `$${base + ci + 1}`).join(",")})`);
        params.push(...values(r));
      });
      await client.query(
        `INSERT INTO craft_roi (${COLS.join(",")}) VALUES ${tuples.join(",")}`,
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

export async function closeDb(): Promise<void> {
  await pool.end();
}
