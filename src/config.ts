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

// datawars2 exposes trailing aggregates as `<window>_sell_sold` / `<window>_buy_sold`.
// Only these windows exist — `1w_*` and `1h_*` return null, and `1m_*` is a calendar
// month whose day count is ambiguous, so it is deliberately not offered.
export const VELOCITY_WINDOW_DAYS = { "1d": 1, "2d": 2, "7d": 7 } as const;
export type VelocityWindow = keyof typeof VELOCITY_WINDOW_DAYS;

function velocityWindow(key: string, def: VelocityWindow): VelocityWindow {
  const v = process.env[key];
  if (v === undefined || v === "") return def;
  if (!(v in VELOCITY_WINDOW_DAYS)) {
    throw new Error(
      `env ${key} must be one of ${Object.keys(VELOCITY_WINDOW_DAYS).join("|")}: ${v}`,
    );
  }
  return v as VelocityWindow;
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

  // Trailing window the demand velocity is averaged over. A 1-day window swings
  // ~0.6x-3x run to run on thin items, so recipes flicker on and off the board;
  // 7d smooths that out. Always normalized to a per-DAY rate downstream, so the
  // gates below keep their units whichever window is selected.
  velocityWindow: velocityWindow("VELOCITY_WINDOW", "7d"),

  // Gates (§6). Velocity is per day, averaged over `velocityWindow`.
  gates: {
    // GATE_MIN_SELL_SOLD_1D is the pre-window name, still honoured as a fallback.
    minSellSoldDay: num("GATE_MIN_SELL_SOLD_DAY", num("GATE_MIN_SELL_SOLD_1D", 10)),
    maxDaysToSell: num("GATE_MAX_DAYS_TO_SELL", 7), // supply overhang
    minRoiPct: num("GATE_MIN_ROI_PCT", 10), // ROI floor, percent
    minProfitCopper: num("GATE_MIN_PROFIT_COPPER", 100), // 1 silver
  },

  // datawars2 + gw2 api
  gw2ApiBase: process.env.GW2_API_BASE ?? "https://api.guildwars2.com",
  datawarsBase: process.env.DATAWARS_BASE ?? "https://api.datawars2.ie",
} as const;

export type Config = typeof config;
