// Entrypoint. One run = one CronJob invocation: compute top-N, TRUNCATE+INSERT, exit.
import { run } from "./pipeline.ts";
import { closeDb, writeRows } from "./db.ts";

const started = Date.now();
try {
  const { known, learnable } = await run();
  await writeRows(known, learnable); // 10. TRUNCATE + INSERT (both tables)
  console.log(
    `wrote ${known.length} known + ${learnable.length} learnable rows in ${Date.now() - started}ms`,
  );
} catch (e) {
  console.error("run failed:", e instanceof Error ? e.stack ?? e.message : e);
  process.exitCode = 1;
} finally {
  await closeDb();
}
