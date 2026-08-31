// Entrypoint. One Cron Trigger invocation = one full recompute: pull GW2 account + market
// data, rank craftable recipes by profit, replace both ROI tables, append the ledger rows.
//
// `scheduled()` only — this Worker has no route and no custom domain, so it has zero public
// surface by construction rather than by policy. It is the half that holds ARENA_NET_KEY and
// makes the account-authenticated calls; the board (apps/web) only ever reads D1.
import {
  buildConfig,
  createDb,
  createGw2Client,
  knownTransactionIds,
  phase,
  resetTimings,
  run,
  timings,
  writeBalance,
  writeRows,
  writeTransactions,
} from "@gw2/core";

export interface Env {
  DB: D1Database;
  // Secret, shipped by CI via WORKER_SECRETS. Everything else is a `vars` entry read by
  // buildConfig() — see §10 and apps/cron/wrangler.jsonc.
  ARENA_NET_KEY: string;
}

export default {
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // A warm isolate carries module state between invocations; the phase table is the one
    // piece of it that would silently corrupt the next run's log line.
    resetTimings();
    const started = Date.now();

    // Build config first: it throws on a missing ARENA_NET_KEY, which fails the invocation in
    // milliseconds instead of after a full pipeline's worth of API calls.
    const cfg = buildConfig(env as unknown as Record<string, unknown>);
    const db = createDb(env.DB);
    const api = createGw2Client(cfg);

    try {
      const { known, learnable } = await run(cfg, db, api);
      // Latest-only: DELETE + chunked INSERT per table, each in one batch (§4).
      await phase("write_rows", () => writeRows(db, known, learnable));

      // TP transaction history for the investment graph (accumulate-only). Pass what's already
      // banked so paging stops at the first page with nothing new — a steady account then costs
      // 2 requests here instead of walking all ten pages of both histories every hour.
      const bankedTxnIds = await phase("known_txns", () => knownTransactionIds(db));
      const txns = await phase("fetch_txns", () => api.fetchTpTransactions(bankedTxnIds));
      await phase("write_txns", () => writeTransactions(db, txns));

      // Wallet coin snapshot — the only way balance history accrues (API gives current only).
      const coin = await phase("wallet", () => api.fetchWalletCoin());
      if (coin !== null) await phase("write_balance", () => writeBalance(db, coin));

      console.log(
        `wrote ${known.length} known + ${learnable.length} learnable rows, ` +
          `${txns.length} new tp transactions (${bankedTxnIds.size} already banked), ` +
          `balance=${coin ?? "n/a"}c ` +
          `in ${Date.now() - started}ms`,
      );
      console.log(`timings: ${timings()}`);
    } catch (e) {
      console.error("run failed:", e instanceof Error ? (e.stack ?? e.message) : e);
      // Phase breakdown up to the failure point — tells you which phase was in flight, which is
      // the only signal a killed or crashed run leaves behind.
      console.error(`timings at failure: ${timings()}`);
      // Rethrow rather than swallow: a thrown scheduled() is what marks the invocation failed.
      // There is no exit code to set here.
      throw e;
    }
  },
};
