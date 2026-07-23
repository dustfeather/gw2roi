// Runtime config. Env comes from ConfigMap (gates/tuning) + Secrets (API key, DB creds).

function env(key: string): string {
  const v = process.env[key];
  if (v === undefined || v === "") throw new Error(`missing required env: ${key}`);
  return v;
}

function num(key: string, def: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${key} not a number: ${v}`);
  return n;
}

export const config = {
  // Secrets
  arenaNetKey: env("ARENA_NET_KEY"),

  // Postgres — either DATABASE_URL or discrete parts.
  databaseUrl: process.env.DATABASE_URL,
  pg: {
    host: process.env.PGHOST ?? "localhost",
    port: num("PGPORT", 5432),
    user: process.env.PGUSER ?? "gw2",
    password: process.env.PGPASSWORD ?? "",
    database: process.env.PGDATABASE ?? "gw2",
  },

  // Ranking output size
  topN: num("TOP_N", 100),

  // The TP listing fee retained by seller: 1 - listing(5%) - sale(10%) = 0.85
  tpKeepRatio: num("TP_KEEP_RATIO", 0.85),

  // Gates (§6)
  gates: {
    minSellSold1d: num("GATE_MIN_SELL_SOLD_1D", 10), // demand velocity
    maxDaysToSell: num("GATE_MAX_DAYS_TO_SELL", 7), // supply overhang
    minRoiPct: num("GATE_MIN_ROI_PCT", 10), // ROI floor, percent
    minProfitCopper: num("GATE_MIN_PROFIT_COPPER", 100), // 1 silver
  },

  // datawars2 + gw2 api
  gw2ApiBase: process.env.GW2_API_BASE ?? "https://api.guildwars2.com",
  datawarsBase: process.env.DATAWARS_BASE ?? "https://api.datawars2.ie",
} as const;

export type Config = typeof config;
