# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`gw2roi` — a TypeScript pnpm monorepo deployed as **two Cloudflare Workers** sharing one D1
database:

- `apps/cron` (`gw2-roi-cron`) — `scheduled()` only, hourly Cron Trigger. One invocation = one
  full recompute: pull GW2 account + market data, rank craftable recipes by profit, replace both
  ROI tables, append the ledger rows. No route, no custom domain, no public surface at all.
- `apps/web` (`gw2-roi-web`) — `fetch()` only. Server-rendered board on `gw2.itguys.ro`, behind
  Cloudflare Access. Reads D1, never writes, never touches the GW2 API.
- `packages/core` — the actual value: cost model, gates, pipeline, schema. Both Workers import it.

`DESIGN.md` is the spec and is actively referenced from code comments by section number
(§4 cost model, §5 ROI, §6 gates, §10 config surface, §11 pipeline). When changing pipeline
semantics, keep DESIGN.md and those `(§n)` comments in sync.
`docs/PLAN-cloudflare-migration.md` is the migration record — read it before questioning a shape
decision, it has the measurements.

## Commands

```sh
pnpm install
pnpm typecheck                     # tsc at the root + `pnpm -r typecheck` (both Workers + core)
pnpm db:generate                   # drizzle-kit generate -> drizzle/
pnpm --filter @gw2/web build:css   # Tailwind -> src/vendor/app.css.txt (committed)
```

There is **no test suite and no linter** — `typecheck` is the only check, and it is what CI and
the pre-commit hook run. Don't invoke `tsc` by hand to verify a change; `.githooks/pre-commit`
already runs the workspace typecheck on staged `.ts`/`.tsx` and `jq`-validates staged JSON
(`tsconfig*.json` and `wrangler.jsonc` are skipped — they are JSONC and jq rejects comments).
Bypass with `GW2_SKIP_TSC=1` / `GW2_SKIP_JSON_CHECK=1`.

Cloudflare operations (needs `CLOUDFLARE_API_TOKEN` in `.env`):

```sh
npx wrangler d1 migrations apply gw2 --remote          # CI does this pre-deploy; rarely manual
npx wrangler d1 execute gw2 --remote --command "..."   # ad-hoc query
npx wrangler tail gw2-roi-cron                         # live logs from the hourly job
bash scripts/seed-cache.sh [--refresh]                 # reseed recipe_defs/item_defs — manual, expansion only
```

## Architecture

`apps/cron/src/worker.ts` → `packages/core/pipeline.ts` is the whole control flow; everything else
in `packages/core` is a leaf module.

**Config is built per invocation, not per module.** Workers deliver env as a handler argument and
have no `process.env`, so `buildConfig(env)` runs inside `scheduled()` and the `Config` is threaded
down. `createGw2Client(cfg)` closes over it — including the request-throttle clock, which is
per-run state on purpose: module scope on Workers is per **isolate**, and a warm isolate would
otherwise start a run believing it already spent its budget. `resetTimings()` exists for the same
reason.

**Two candidate sets, one pass.** `pipeline.run()` splits qualified recipes into `known`
(craftable now) and `learnable` (disciplines qualify, recipe not unlocked) and scores both,
writing `craft_roi` and `craft_roi_learnable`. The split matters for costing: the known table
uses a cost model whose `craftMap` contains only **known** intermediates; the learnable table's
model may craft any qualified intermediate. Two separate memo maps — never share one across
the two models.

**Costing is recursive and memoized** (`packages/core/cost.ts`). `costOf(item, need) = min(TP
instant-buy at sell_price, craft-it, coin-vendor, spend-held-stock)`; `visited` guards recipe
cycles. A leaf with no obtainable price returns `null`, which disqualifies the entire branch —
this null-propagation is the main correctness constraint.

**Every recipe is costed twice, from one plan.** The market pass memoizes a `Source` per
`(item, need)` — *which* supply won, not just its price — producing `craft_cost` / `profit` /
`roi_pct`. `outOfPocketCost` then re-walks that same plan against a **per-recipe copy of
`heldMats`** (all bank + material-storage stock, tradable included), paying market price only
for what the copy cannot cover, and produces `out_of_pocket` / `owned_value` / `net_profit` /
`net_roi_pct` (§5). Two models and **two memo maps** — known/learnable — never shared across
the two, since their `craftMap`s differ.

The inventory copy is **decremented as it is spent**, and that is load-bearing. The old model
tested `heldMats.get(id) >= need` independently at each node, so one stack paid for several
branches: a tree needing 11 Glob of Ectoplasm across three sub-crafts priced all 11 at zero off
9 in the bank, because no single node ever asked for more than 5 (issue #1, ~6.2k copper on one
recipe). `net_profit` is the rank key and the error grew with tree depth, so it favoured exactly
the deep ascended chains it was least true for. Deciding the plan once, in the market pass, is
also what keeps the memo shareable — a decrementing inventory is order-dependent and cannot be
cached on `(item, need)` alone. Drop-only mats are the one exception: they stay free past
exhaustion, because in the market model held stock is their *only* supply, not a discount.

`need` is the **quantity demanded**, threaded down the tree (`craftCost` multiplies by
`ceil(need / output_item_count)`) and part of the memo key. TP/vendor supply is unlimited so
`need` never constrains it; held stock is finite, so a drop-only mat is only usable while
`ownedMats.get(id) >= need`. That check is the only thing separating grind-gated map mats
(Ley Line Spark, Pile of Auric Dust, Bottle of Airship Oil, Obsidian Shard) from genuinely-free
overflow mats (Bloodstone Dust) — their item flags are **identical**, quantity is the only signal.
Drop it and one Ley Line Spark in the bank prices all 25 a recipe needs at 0c, floating ascended
recipes to the top of the board. Owned mats are also priced free **only** when not TP-obtainable
(`tpPrice === 0`); pricing owned-but-tradable mats at 0 massively inflates ROI.

**Data sources** (`packages/core/gw2api.ts`, `datawars.ts`): official GW2 API for account state and
recipe/item definitions — throttled to ~5 req/s, 200 ids/request, 429/5xx retried with linear
backoff. Market prices and velocity come from datawars2 (`api.datawars2.ie`, no auth,
500 ids/request), not from the GW2 TP endpoints. Velocity fields are windowed
(`<window>_sell_sold`, windows `1d`/`2d`/`7d` only) and return the window **total**;
`datawars.ts` divides by the window length so everything downstream is a per-day rate.
Selected by `VELOCITY_WINDOW`, default `7d` — a 1d window swings ~0.6x-3x run to run and
flickers thin recipes on and off the board.

**Gates** (`packages/core/roi.ts`, `passes`): output sellable, `sell_sold_day ≥
GATE_MIN_SELL_SOLD_DAY`, `days_to_sell ≤ GATE_MAX_DAYS_TO_SELL`, `roi_pct ≥ GATE_MIN_ROI_PCT`,
`profit ≥ GATE_MIN_PROFIT_COPPER`. All money is **copper** integers; `TP_KEEP_RATIO` (0.85) is the
seller's take after the 5% listing + 10% sale fee. Velocity is per day — keep it that way, or
`days_to_sell` silently stops being days.

## Persistence — D1

Schema lives in `packages/core/schema.ts` (Drizzle, `sqliteTable`). Changes are
`pnpm db:generate` → a numbered file in `drizzle/`, applied by
`wrangler d1 migrations apply` in CI **before** the new code deploys. This replaced the old
inline-DDL-every-run model, where idempotency *was* the mechanism and nothing recorded what had
been applied.

Column names stay snake_case and identical to the Postgres originals, and the TS property names
match them, so a row maps 1:1 onto `RoiRow`.

`craft_roi` / `craft_roi_learnable` are latest-only (DELETE + chunked INSERT in one `db.batch()`,
which D1 runs as a single implicit transaction). `tp_transactions` is accumulate-only (insert-or-
ignore by id) so history survives the API's ~90-day window. `account_balance` is likewise
accumulate-only, one wallet-coin snapshot appended per run — `/v2/account/wallet` returns only the
*current* balance, so that table is the only balance history that will ever exist; **never
truncate it**. It doubles as the run-duration series.

Two D1 limits shape every write:

- **100 bound parameters per query.** `craft_roi` binds 18 columns, so a multi-row INSERT fits
  5 rows. Definition upserts write `fetched_at` as a SQL expression rather than a bound value,
  which halves the statement count on a cold cache.
- **`db.batch()` is one implicit transaction.** Anything that must be atomic has to fit in a
  single call — hence one batch per ROI table, DELETE first.

`recipe_defs` / `item_defs` are the static-definition caches, read with a **full-table scan** (two
queries a run). The `WHERE id = ANY($1)` chunking was a Postgres artifact: the pipeline reads
essentially the whole cache every run, and SQLite has no array parameter. The oldest-first refresh
slice is picked **in memory** from those same rows — there is no second query for it. They are
self-maintaining, so **new recipes need no manual step**. `scripts/seed-cache.ts` is only for a
cold/lost cache or a patch that rewrites definitions already cached under the same ids. It is not
on any schedule and deliberately so: it stays local Bun, fetches into `.seed/*.jsonl` (which is
what makes it resumable) and emits SQL that `seed-cache.sh` applies with `wrangler d1 execute
--file`.

Known gotchas encoded in the code: `/v2/account/recipes` reports only `LearnedFromItem` sheet
unlocks — never discovery recipes — so `isKnown()` treats every discovery recipe as known and
`learn_method` is `BUY` (sheet) vs `DISCOVER` (free). `disciplineOk()` requires the account to
actually *have* the discipline, otherwise every 0-rating recipe leaks in.

## Config & secrets

Runtime config is env-only (`packages/core/config.ts`). Non-secret tuning lives in `vars` in
`apps/cron/wrangler.jsonc`; `ARENA_NET_KEY` is a **GitHub Actions Secret** and is the single
source of truth — `.github/workflows/deploy.yml` ships it onto the Worker with the deploy via
`WORKER_SECRETS`. Never `wrangler secret put` by hand and never commit values.

`database_id` in both wrangler configs is committed on purpose: it is inert without
`CLOUDFLARE_API_TOKEN`, the same category as a bucket name.

## CI/CD

Push to `main` (deny-list `paths-ignore`, not an allow-list) → `deploy.yml`: typecheck gate, then
two `deploy-cloudflare.yml@v4` callers on the ARC runner `arc-df-gw2roi`. `deploy-web` needs
`deploy-cron`, so the board never deploys against an unmigrated schema. `checks.yml` covers PRs.

- Migrations run once, in the cron job's `pre-deploy-command`.
- **`expect-crons: 0 * * * *`** is the gate that matters here. A cron-only Worker has no HTTP
  surface for `verify-url`, and wrangler treats an absent `triggers` block as "leave whatever is
  registered alone" — so a misplaced or unread config section deploys green with zero schedules,
  and the failure surfaces an hour later as "the job never ran".
- **`apps/cron` must deploy with plain `wrangler deploy`.** Do not override `deploy-command` to
  `wrangler versions upload`: under that path crons are applied only by a separate,
  still-experimental `wrangler triggers deploy`, so they would register never.
- Neither Worker sets `verify-url`. The cron Worker has nothing to curl; the board is behind
  Access, so an unauthenticated curl gets a 302 and would fail every deploy. Accepted consequence:
  a wrong binding name or a throwing SSR template ships green and surfaces on first use.

## The board

`apps/web`, Hono + JSX, server-rendered, **zero client JavaScript** — the D1 binding, the queries
and the whole ledger stay server-side. Layout: stat row, full-width cumulative TP graph, then
CRAFTABLE NOW and LEARNABLE side by side.

The two-up row is deliberate: the velocity gates routinely leave three rows in one table, and
stacking two of those under a full-width graph looks broken. It still degrades sanely if a patch
floods the board.

**`net_profit` is the single rank key** — `pipeline.ts` top-N selection, both table `ORDER BY`s,
and the headline stat panel. If you change one, change all of them: selection and display sharing
a key is what stops top-N from picking a different set than the board renders. Market-true
`profit` is still shown per row but does **not** rank. ROI stays a gate (`GATE_MIN_ROI_PCT`,
evaluated on the market-true figures) and a displayed figure, never a rank key.

Formatting happens at render (`fmtCoin`), never in SQL. That is not just a SQLite constraint: the
Grafana panels selected `fmt_coin(profit) AS profit`, and PostgreSQL resolves a bare `ORDER BY
profit` against the **output alias** first, giving a silent lexicographic sort (`2g 3s 43c` above
`2g 27s 17c`). Sorting the raw integer and formatting afterwards makes that trap impossible.

The board carries **no time filter**, deliberately. `craft_roi` is latest-only — one
DELETE+INSERT per run, so every row shares a single `updated_at` and there is no history to filter
across. The cumulative TP graph reads the accumulate-only tables and plots their whole history.

The graph is inline SVG computed in TypeScript, not SQL. The whole input is ~2.5k rows, and
translating the Grafana panel's window-function CTE (`::numeric` casts, `now()`, `LEFT JOIN … ON
true`) to SQLite would have been all risk and no benefit. Its balance line is dashed because half
of it is reconstructed: before the first wallet snapshot it is cumulative TP flow walked backwards
from a known balance, which is approximate by construction — gold also moves outside the TP.

## Notes

- A thin board is a velocity-gate artifact, not a pricing bug. datawars2's `1d_sell_sold` is a true rolling 24h window (verified 2026-07-25: it is not zeroed after 00:00 UTC reset), but it is noisy enough on low-volume items to push them under `GATE_MIN_SELL_SOLD_DAY` at random. Hence the 7d default window.
- Peak memory tracks `item_defs` row count against a fixed 128 MB isolate ceiling (90.8 MiB measured 2026-08-31). Re-measure after a large game expansion.
- `graphify-out/` is generated by a post-commit hook and gitignored; ignore it when searching.
