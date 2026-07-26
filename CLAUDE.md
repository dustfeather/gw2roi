# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`gw2-crafting-roi-bot` — a single-shot TypeScript/Bun batch job. One process run = one full
recompute: pull GW2 account + market data, rank craftable recipes by profit, `TRUNCATE`+`INSERT`
into Postgres, exit. Deployed as an hourly k3s CronJob in namespace `trading`; Grafana reads
the tables live. No server, no long-lived state in the app.

`DESIGN.md` is the spec and is actively referenced from code comments by section number
(§4 cost model, §5 ROI, §6 gates, §10 config surface, §11 pipeline). When changing pipeline
semantics, keep DESIGN.md and those `(§n)` comments in sync.

## Commands

```sh
bun install
ARENA_NET_KEY=... DATABASE_URL=postgres://gw2:pw@localhost/gw2 bun run start   # full local run
bun run typecheck                                                             # tsc --noEmit
```

There is **no test suite and no linter** — `typecheck` is the only check, and it is what CI
and the pre-commit hook run. Don't invoke `tsc` by hand to verify a change; the pre-commit
hook (`.githooks/pre-commit`) already runs typecheck on staged `.ts` and `jq`-validates
staged JSON. Bypass with `GW2_SKIP_TSC=1` / `GW2_SKIP_JSON_CHECK=1`.

Cluster operations (kube context `k3s-itguys`, namespace `trading`):

```sh
bash scripts/run-now.sh                    # one-off Job from the CronJob, tail logs, row count, repush dashboard
bash scripts/provision-grafana.sh          # upsert datasource + dashboard via Grafana HTTP API (needs .env)
kubectl -n trading logs job/<job>          # `kubectl wait` fails: CI Role has no `watch` verb — poll with `get`
```

## Architecture

`src/index.ts` → `src/pipeline.ts` is the whole control flow; everything else is a leaf module.

**Two candidate sets, one pass.** `pipeline.run()` splits qualified recipes into `known`
(craftable now) and `learnable` (disciplines qualify, recipe not unlocked) and scores both,
writing `craft_roi` and `craft_roi_learnable`. The split matters for costing: the known table
uses a cost model whose `craftMap` contains only **known** intermediates; the learnable table's
model may craft any qualified intermediate. Two separate memo maps — never share one across
the two models.

**Costing is recursive and memoized** (`src/cost.ts`). `costOf(item, need) = min(TP instant-buy at
sell_price, craft-it, coin-vendor, spend-held-stock)`; `visited` guards recipe cycles. A leaf with
no obtainable price returns `null`, which disqualifies the entire branch — this null-propagation
is the main correctness constraint.

`need` is the **quantity demanded**, threaded down the tree (`craftCost` multiplies by
`ceil(need / output_item_count)`) and part of the memo key. TP/vendor supply is unlimited so
`need` never constrains it; held stock is finite, so a drop-only mat is only usable while
`ownedMats.get(id) >= need`. That check is the only thing separating grind-gated map mats
(Ley Line Spark, Pile of Auric Dust, Bottle of Airship Oil, Obsidian Shard) from genuinely-free
overflow mats (Bloodstone Dust) — their item flags are **identical**, quantity is the only signal.
Drop it and one Ley Line Spark in the bank prices all 25 a recipe needs at 0c, floating ascended
recipes to the top of the board. Owned mats are also priced free **only** when not TP-obtainable
(`tpPrice === 0`); pricing owned-but-tradable mats at 0 massively inflates ROI.

**Data sources** (`src/gw2api.ts`, `src/datawars.ts`): official GW2 API for account state and
recipe/item definitions — throttled to ~5 req/s, 200 ids/request, 429/5xx retried with linear
backoff. Market prices and velocity come from datawars2 (`api.datawars2.ie`, no auth,
500 ids/request), not from the GW2 TP endpoints. Velocity fields are windowed
(`<window>_sell_sold`, windows `1d`/`2d`/`7d` only) and return the window **total**;
`datawars.ts` divides by the window length so everything downstream is a per-day rate.
Selected by `VELOCITY_WINDOW`, default `7d` — a 1d window swings ~0.6x-3x run to run and
flickers thin recipes on and off the board.

**Gates** (`src/roi.ts`, `passes`): output sellable, `sell_sold_day ≥ GATE_MIN_SELL_SOLD_DAY`,
`days_to_sell ≤ GATE_MAX_DAYS_TO_SELL`, `roi_pct ≥ GATE_MIN_ROI_PCT`, `profit ≥
GATE_MIN_PROFIT_COPPER`. All money is **copper** integers; `TP_KEEP_RATIO` (0.85) is the
seller's take after the 5% listing + 10% sale fee. Velocity is per day — keep it that way, or
`days_to_sell` silently stops being days.

**Persistence** (`src/db.ts`): DDL lives inline in this file and runs on every execution —
schema changes are additive `ALTER TABLE ... IF NOT EXISTS` / guarded `DO $$` blocks appended
to the DDL strings, not migration files. `craft_roi` / `craft_roi_learnable` are latest-only
(TRUNCATE + chunked INSERT in one transaction); `tp_transactions` is accumulate-only (upsert
by id) so history survives the API's ~90-day window. `fmt_coin(bigint)` is a Postgres function
created here so dashboard SQL stays DRY.

Known gotchas encoded in the code: `/v2/account/recipes` reports only `LearnedFromItem` sheet
unlocks — never discovery recipes — so `isKnown()` treats every discovery recipe as known and
`learn_method` is `BUY` (sheet) vs `DISCOVER` (free). `disciplineOk()` requires the account to
actually *have* the discipline, otherwise every 0-rating recipe leaks in.

## Config & secrets

Runtime config is env-only (`src/config.ts`). Non-secret tuning lives in `k8s/configmap.yaml`;
`ARENA_NET_KEY` and `PG_PASSWORD` are **GitHub Actions Secrets** and are the single source of
truth — `.github/workflows/deploy.yml` pushes them into the cluster. Never `kubectl create
secret` by hand and never commit values. See `k8s/SECRETS.md`.

## CI/CD

Push to `main` touching `src/`, `data/`, `Dockerfile`, or `package.json` → `build.yml`
(typecheck gates the image build → GHCR) → `deploy.yml` on `workflow_run` success, running on
the in-cluster ARC runner `arc-df-gw2roi`: syncs secrets, applies ConfigMap + CronJob, kicks an
init Job. `checks.yml` covers PRs only (push-to-main typecheck already runs inside `build.yml`).

Not deployed by CI — bootstrap once with an admin kubeconfig, the deployer Role lacks the verbs:
`k8s/rbac.yaml`, `k8s/postgres.yaml`, the `arc-df-gw2roi` scale set. Grafana is also **not**
provisioned from CI: dashboards live in `k8s/grafana/dashboards/` and are pushed locally with
`scripts/provision-grafana.sh`.

Dashboard edits: commit and push to `main` immediately, no confirmation needed.

## Grafana

Dashboards live in `k8s/grafana/dashboards/` and are pushed with
`scripts/provision-grafana.sh` (never by CI). `k8s/grafana/dashboard.yaml` is an older
ConfigMap-provisioning variant kept in sync but not the one actually served.

Both ROI tables sort in **SQL**, not via the panel's `sortBy` — the profit column is a
formatted `fmt_coin` string (`"1g 23s 4c"`), so a UI sort would order it lexicographically.
Change the `ORDER BY` if you want a different default sort.

**Always table-qualify the sort column** (`ORDER BY craft_roi.profit DESC`). The panels do
`fmt_coin(profit) AS profit`, and PostgreSQL resolves a bare `ORDER BY profit` against the
**output alias first** — which is the `fmt_coin` text, giving a silent lexicographic sort
(`2g 3s 43c` ranked above `2g 27s 17c`). It looks almost right, which is what makes it nasty.

**Profit is the single rank key** — `pipeline.ts` top-N selection, both table `ORDER BY`s, and
the headline stat panel. If you change one, change all of them: selection and display sharing
a key is what stops top-N from picking a different set than the board renders. ROI stays a
gate (`GATE_MIN_ROI_PCT`) and a displayed figure, never a rank key.

The two ROI tables carry **no `$__timeFilter`, deliberately** (decided 2026-07-25). `craft_roi`
is latest-only — one TRUNCATE+INSERT per run, so every row shares a single `updated_at` and
there is no history to filter across. A time filter would be all-or-nothing: full table when
the picker window happens to span the last hourly run, blank otherwise. The time picker is
meaningful only for the cumulative TP graph, which reads the accumulate-only `tp_transactions`.
Making it meaningful for the tables means storing per-run snapshots instead.

## Notes

- A thin board is a velocity-gate artifact, not a pricing bug. datawars2's `1d_sell_sold` is a true rolling 24h window (verified 2026-07-25: it is not zeroed after 00:00 UTC reset), but it is noisy enough on low-volume items to push them under `GATE_MIN_SELL_SOLD_DAY` at random. Hence the 7d default window.
- `graphify-out/` is generated by a post-commit hook and gitignored; ignore it when searching.
