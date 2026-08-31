// Runtime config (§10). Workers hand env to the handler as an argument — there is no
// `process.env` and no module-scope environment — so this builds a Config from the `env`
// object at the top of each invocation and threads it down. Non-secret tuning comes from
// `vars` in wrangler.jsonc, `ARENA_NET_KEY` from a Worker secret.

// Everything arrives as a string from `vars`/secrets, but a JSON number in wrangler.jsonc
// would arrive as a number, so accept both rather than trusting the config file's quoting.
export type ConfigEnv = Record<string, unknown>;

function raw(env: ConfigEnv, key: string): string | number | undefined {
  const v = env[key];
  if (typeof v === "string" || typeof v === "number") return v;
  return undefined;
}

function str(env: ConfigEnv, key: string): string {
  const v = raw(env, key);
  if (v === undefined || v === "") throw new Error(`missing required env: ${key}`);
  return String(v);
}

function num(env: ConfigEnv, key: string, def: number): number {
  const v = raw(env, key);
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${key} not a number: ${String(v)}`);
  return n;
}

function optStr(env: ConfigEnv, key: string, def: string): string {
  const v = raw(env, key);
  return v === undefined || v === "" ? def : String(v);
}

// datawars2 exposes trailing aggregates as `<window>_sell_sold` / `<window>_buy_sold`.
// Only these windows exist — `1w_*` and `1h_*` return null, and `1m_*` is a calendar
// month whose day count is ambiguous, so it is deliberately not offered.
export const VELOCITY_WINDOW_DAYS = { "1d": 1, "2d": 2, "7d": 7 } as const;
export type VelocityWindow = keyof typeof VELOCITY_WINDOW_DAYS;

function velocityWindow(env: ConfigEnv, key: string, def: VelocityWindow): VelocityWindow {
  const v = raw(env, key);
  if (v === undefined || v === "") return def;
  const s = String(v);
  if (!(s in VELOCITY_WINDOW_DAYS)) {
    throw new Error(
      `env ${key} must be one of ${Object.keys(VELOCITY_WINDOW_DAYS).join("|")}: ${s}`,
    );
  }
  return s as VelocityWindow;
}

export interface Config {
  arenaNetKey: string;
  topN: number;
  tpKeepRatio: number;
  velocityWindow: VelocityWindow;
  gates: {
    minSellSoldDay: number;
    maxDaysToSell: number;
    minRoiPct: number;
    minProfitCopper: number;
  };
  gw2ApiBase: string;
  datawarsBase: string;
  recipeRefreshPerRun: number;
}

// Built once per invocation, inside the handler. Throwing here fails the run before any API
// work happens — the same preflight the module-scope `config` const used to give us, except
// a Worker cannot do it at import time because `env` does not exist yet.
export function buildConfig(env: ConfigEnv): Config {
  return {
    // Secret
    arenaNetKey: str(env, "ARENA_NET_KEY"),

    // Ranking output size
    topN: num(env, "TOP_N", 100),

    // The TP listing fee retained by seller: 1 - listing(5%) - sale(10%) = 0.85
    tpKeepRatio: num(env, "TP_KEEP_RATIO", 0.85),

    // Trailing window the demand velocity is averaged over. A 1-day window swings
    // ~0.6x-3x run to run on thin items, so recipes flicker on and off the board;
    // 7d smooths that out. Always normalized to a per-DAY rate downstream, so the
    // gates below keep their units whichever window is selected.
    velocityWindow: velocityWindow(env, "VELOCITY_WINDOW", "7d"),

    // Gates (§6). Velocity is per day, averaged over `velocityWindow`.
    gates: {
      // GATE_MIN_SELL_SOLD_1D is the pre-window name, still honoured as a fallback.
      minSellSoldDay: num(env, "GATE_MIN_SELL_SOLD_DAY", num(env, "GATE_MIN_SELL_SOLD_1D", 10)),
      maxDaysToSell: num(env, "GATE_MAX_DAYS_TO_SELL", 7), // supply overhang
      minRoiPct: num(env, "GATE_MIN_ROI_PCT", 10), // ROI floor, percent
      minProfitCopper: num(env, "GATE_MIN_PROFIT_COPPER", 100), // 1 silver
    },

    // datawars2 + gw2 api
    gw2ApiBase: optStr(env, "GW2_API_BASE", "https://api.guildwars2.com"),
    datawarsBase: optStr(env, "DATAWARS_BASE", "https://api.datawars2.ie"),

    // How many already-cached recipe definitions to re-fetch per run, oldest first. Recipe
    // definitions only change on a game patch, so they are cached in D1 (recipe_defs) and
    // re-read instead of re-fetched. This trickle is what keeps the cache honest without ever
    // re-pulling all ~13k in one burst: at 600/run the whole table turns over in about a day
    // of hourly runs, costing 3 requests an hour instead of 66.
    recipeRefreshPerRun: num(env, "RECIPE_REFRESH_PER_RUN", 600),
  };
}
