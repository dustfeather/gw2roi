// Entrypoint. One run = one CronJob invocation: compute top-N, TRUNCATE+INSERT, exit.
import { run } from "./pipeline.ts";
import { fetchTpTransactions, fetchWalletCoin } from "./gw2api.ts";
import { closeDb, pingDb, writeBalance, writeRows, writeTransactions } from "./db.ts";
import { phase, timings } from "./timing.ts";

const started = Date.now();
try {
  // Preflight before any API work: the writes below only land after the full pipeline, so an
  // unreachable database has to surface in seconds rather than ~12 minutes from now.
  await phase("db_ping", pingDb);

  const { known, learnable } = await run();
  await phase("write_rows", () => writeRows(known, learnable)); // 10. TRUNCATE + INSERT (both tables)

  // TP transaction history for the investment graph (accumulate-only).
  const txns = await phase("fetch_txns", fetchTpTransactions);
  await phase("write_txns", () => writeTransactions(txns));

  // Wallet coin snapshot — the only way balance history accrues (API gives current only).
  const coin = await phase("wallet", fetchWalletCoin);
  if (coin !== null) await phase("write_balance", () => writeBalance(coin));

  console.log(
    `wrote ${known.length} known + ${learnable.length} learnable rows, ` +
      `${txns.length} tp transactions, balance=${coin ?? "n/a"}c ` +
      `in ${Date.now() - started}ms`,
  );
  console.log(`timings: ${timings()}`);
} catch (e) {
  console.error("run failed:", e instanceof Error ? e.stack ?? e.message : e);
  // Phase breakdown up to the failure point — tells you which phase was in flight, which is
  // the only signal a killed or crashed run leaves behind.
  console.error(`timings at failure: ${timings()}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
