// Entrypoint. One run = one CronJob invocation: compute top-N, TRUNCATE+INSERT, exit.
import { run } from "./pipeline.ts";
import { closeDb, writeRows } from "./db.ts";

const started = Date.now();
try {
  const rows = await run();
  await writeRows(rows); // 10. TRUNCATE + INSERT
  console.log(`wrote ${rows.length} rows in ${Date.now() - started}ms`);
} catch (e) {
  console.error("run failed:", e instanceof Error ? e.stack ?? e.message : e);
  process.exitCode = 1;
} finally {
  await closeDb();
}
