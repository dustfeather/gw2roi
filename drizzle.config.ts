import { defineConfig } from "drizzle-kit";

// Migrations are generated here and applied through wrangler, not drizzle-kit — D1 is the
// only target and `wrangler d1 migrations apply` owns the migration ledger (`d1_migrations`
// in the database). `drizzle-kit push` is therefore never run against D1.
//
// `out` is the repo-root `drizzle/`, which both Workers point their `migrations_dir` at.
export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/core/schema.ts",
  out: "./drizzle",
});
