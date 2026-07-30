// Entrypoint. One run = one CronJob invocation: compute top-N, TRUNCATE+INSERT, exit.
import { run } from "./pipeline.ts";
import { fetchTpTransactions, fetchWalletCoin } from "./gw2api.ts";
import { closeDb, writeBalance, writeRows, writeTransactions } from "./db.ts";

const started = Date.now();
try {
  const { known, learnable } = await run();
  await writeRows(known, learnable); // 10. TRUNCATE + INSERT (both tables)

  // TP transaction history for the investment graph (accumulate-only).
  const txns = await fetchTpTransactions();
  await writeTransactions(txns);

  // Wallet coin snapshot — the only way balance history accrues (API gives current only).
  const coin = await fetchWalletCoin();
  if (coin !== null) await writeBalance(coin);

  console.log(
    `wrote ${known.length} known + ${learnable.length} learnable rows, ` +
      `${txns.length} tp transactions, balance=${coin ?? "n/a"}c ` +
      `in ${Date.now() - started}ms`,
  );
} catch (e) {
  console.error("run failed:", e instanceof Error ? e.stack ?? e.message : e);
  process.exitCode = 1;
} finally {
  await closeDb();
}
