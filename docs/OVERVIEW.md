# gw2

## Goal

A Guild Wars 2 crafting-ROI bot. It ranks the top-N craftable items by profit per craft and shows them on a board at `gw2.itguys.ro`. A Cloudflare Cron Trigger computes the board every hour over D1, and a separate Worker renders it server-side.

- `apps/cron/` (`gw2-roi-cron`): `scheduled()` only, with no route. It pulls account discipline ratings, unlocked recipes and the full recipe list from the GW2 API. It splits them into **known** recipes (craftable now) and **learnable** ones (the disciplines qualify but the recipe isn't unlocked). It bulk-fetches TP prices and velocity from datawars2 and costs each candidate recursively by its cheapest source: `min(TP instant-buy, craft-it, coin-vendor, spend-held-stock)`. Then it applies the gates, sorts by `net_profit` and writes `craft_roi` + `craft_roi_learnable`, plus new transactions and one wallet snapshot.
- `apps/web/` (`gw2-roi-web`): `fetch()` only. It serves `gw2.itguys.ro` behind Cloudflare Access, reads D1 live and renders the board.

## Stack

- TypeScript (`typescript` ^7.0.0) in a pnpm workspace. pnpm 12.3.4 is declared through `devEngines.packageManager` (`onFail: warn`), not `packageManager`.
- Cloudflare Workers + D1 (`wrangler` ^4.135.0, `@cloudflare/workers-types`), with Cron Triggers for the hourly run.
- Drizzle: `drizzle-kit` ^0.31.0. The schema is in `packages/core/schema.ts` and generated migrations go in `drizzle/`.
- Tailwind for the web board. `pnpm --filter @gw2/web build:css` builds it, and the output is committed.
- Bun (`bun-types`) runs only the local `scripts/seed-cache.ts` seeder, which is not deployed.
- External data: the GW2 API (ArenaNet key scoped to account, characters, unlocks, inventories, tradingpost, wallet) and datawars2 (TP prices + velocity).
- Checks: `pnpm typecheck` (`tsc --noEmit && pnpm -r typecheck`) is the only check the repo has. `prepare` sets `core.hooksPath .githooks`.

## Repo

- `dustfeather/gw2roi` (confirmed: `git@github.com:dustfeather/gw2roi.git`). The local directory is named `gw2`.
- Layout:
  - `apps/cron`, `apps/web`: the two Workers.
  - `packages/core` (`@gw2/core`): cost model, gates, pipeline and D1 schema, imported by both Workers.
  - `drizzle/`: migrations.
  - `data/`: bundled coin-vendor and free-mat price tables.
  - `scripts/`: `seed-cache.{ts,sh}`.
  - Other top-level entries: `src/`, `cutover/`, `DESIGN.md` (the design doc), `CLAUDE.md`, `graphify.md` + `graphify-out/` (dated graph snapshots from 2026-07-23 to 2026-09-13), `.serena/`, `.githooks/`, `.github/workflows/`.

## Deploy

A push to `main` runs `deploy.yml`, which typechecks and then deploys two Workers in order:

1. `gw2-roi-cron`: migrations run first, and the cron triggers are checked after the deploy.
2. `gw2-roi-web`.

Both deploy through `dustfeather/shared-workflows`' `deploy-cloudflare.yml`. The README still says `@v4` on the ARC runner `arc-df-gw2roi`, but recent commits moved the repo to GitHub-hosted runners and shared-workflows v8, so that part of the README is stale.

GitHub is the single source of truth for secrets. `ARENA_NET_KEY`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are GitHub Actions secrets, and the deploy ships them onto the Worker. Never use `wrangler secret put` by hand.

One-time bootstrap, done by hand:

- `wrangler d1 create gw2`, with its `database_id` pasted into both `wrangler.jsonc` files, then the first remote migration.
- A self-hosted Access app for `gw2.itguys.ro` with the `Admin Access` policy.

Wrangler creates the proxied DNS record itself from the `custom_domain` route. Don't create it by hand: the binding fails if a record already exists.

The app runs on Cloudflare, not on the homelab cluster.

## Status

active, v1.0.0. The graphify snapshots show active development from late July to mid-September 2026. Recent work is mostly CI and dependencies:

- moved to GitHub-hosted runners and shared-workflows v8
- Claude review in CI limited to Dependabot PRs
- Dependabot version updates for npm and actions
- fixed installation under pnpm 12 (switched from `packageManager` to `devEngines`)
- bumped wrangler to clear a sharp heap overflow

## Notes

- Schedule: hourly Cloudflare Cron Trigger. The board reads D1 live, so it is never more than one run stale.
- Ranking: the board ranks by `net_profit`, not ROI. ROI is a gate and a displayed figure, because ranking by ROI favours cheap crafts worth a few copper. Gates:
  - `GATE_MIN_SELL_SOLD_DAY`
  - `GATE_MAX_DAYS_TO_SELL`
  - `GATE_MIN_ROI_PCT`
  - `GATE_MIN_PROFIT_COPPER`
- Tuning: defaults are in `packages/core/config.ts` and live values in `apps/cron/wrangler.jsonc` `vars`. They include `TOP_N`, `TP_KEEP_RATIO`, `VELOCITY_WINDOW` (`1d`/`2d`/`7d`, default `7d`, always expressed per day) and `RECIPE_REFRESH_PER_RUN` (600). A 1-day window swings about 0.6x–3x between runs on thin items, which makes recipes flicker on and off the board.
- Definition cache: `recipe_defs` and `item_defs` live in D1. A warm run costs about 6 GW2 API requests instead of about 96. Each run fetches ids the cache hasn't seen and re-reads the 600 oldest rows, so the whole table turns over in about a day. Run `scripts/seed-cache.sh` (with `--refresh`) only after a cold or lost cache or a patch that rewrites existing definitions. A cold seed takes 10–20 minutes, can be resumed and is safe to interrupt.
- Pricing caveat: `data/coin-vendor.json` bundles only confirmed coin-buyable mats. Missing ones fall back to TP pricing, which overprices the craft and hides real ROI. A thin board comes from the velocity gate, not a pricing bug.
- Memory: peak memory tracks the `item_defs` row count against the fixed 128 MB isolate ceiling (90.8 MiB measured 2026-08-31). Re-measure after a large expansion.
- Related: [shared-workflows](https://github.com/dustfeather/shared-workflows/blob/main/docs/OVERVIEW.md)
- Area: Gaming

## Log

- **2026-09-29** — Note created from repo scan.
