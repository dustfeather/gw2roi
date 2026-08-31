# GW2 Crafting-ROI Bot — Design

Surfaces the **top-N craftable items by profit per craft**, hourly, onto a board at
`gw2.itguys.ro`.
(Rank key changed from ROI% to absolute profit on 2026-07-26 — ROI remains a gate and a
displayed figure. Selection and display must share a key or top-N silently picks a
different set than the board renders.) Every decision below was resolved in the `/grill-me` interview.

---

## 1. Goal

For recipes I can craft *right now*, rank by return on investment (craft cost vs. sell revenue), keeping only items with **real, sellable demand**. Emit top-N to a dashboard.

---

## 2. Data sources

| Source | Use | Notes |
|---|---|---|
| **GW2 official API v2** (`api.guildwars2.com`) | recipes, unlocks, characters, item flags, listing depth | Bearer key from `.env` `ARENA_NET_KEY`; `?v=latest`; retry on random "invalid key" |
| **datawars2** (`api.datawars2.ie/gw2/v1/items/json`) | prices + velocity | bulk `ids=`, no bot protection; `buy_price/sell_price/buy_quantity/sell_quantity/<window>_sell_sold`. Velocity windows are `1d`/`2d`/`7d` (`1w_*` and `1h_*` return null); the field is a window TOTAL, divided by the window length to get `sell_sold_day`. Window selected by `VELOCITY_WINDOW`, default `7d`. |
| **coin-vendor mats** | vendor-for-**coin** mat prices | **hardcoded JSON** `{item_id: coin_per_unit}` (~30–40 items, static; sourced once from wiki `## Acquisition` sections). No scrape, no browser. |

### Rate limiting (GW2 API)
Per-IP token bucket: **burst 300, refill 5/sec**. Limiter runs ~5 req/s sustained + burst 300 ⇒ no 429s. Bulk **200 ids/request**. Handle HTTP 206 (partial) and unknown enums.

---

## 3. Craft scope — "items I can craft right now"

- Discipline ratings = **MAX rating across all characters** (`/v2/characters?ids=all`).
- Candidate recipe is craftable iff:
  - recipe is **unlocked** (`/v2/account/recipes`) **OR** **auto-learned** (`flags` includes `AutoLearned` **and** max discipline rating ≥ `min_rating`), **and**
  - I hold the discipline(s) the recipe needs at sufficient rating.
- Sources: `/v2/recipes/search`, `/v2/recipes` (defs), `/v2/account/recipes`, `/v2/characters`.

---

## 4. Cost model — recursive cheapest-source

For each ingredient, `cost = min( buy-on-TP, craft-it, buy-from-coin-vendor, spend-held-stock )`, computed recursively.

- **Leaf validity:** an ingredient is acceptable only if it is a **TP-buyable Item** (`sell_price > 0`), a **coin-vendor mat** (present in the hardcoded coin-price JSON), or a drop-only mat the account **already holds in at least the quantity the craft consumes**.
- **Supply is finite for held stock only.** TP and vendor supply is treated as unlimited, so the required quantity never constrains them. Drop-only mats are the opposite: they cannot be re-bought, so the recursion carries the demanded quantity down the tree and a leaf is only usable while `owned ≥ needed`. Without that, owning one Ley Line Spark would price all 25 a recipe needs at 0c.
- **Disqualify the whole recipe** if any leaf is `Currency`, `GuildUpgrade`, karma, or otherwise not obtainable for gold/TP — including a drop-only mat held in insufficient quantity.
- TP fee: **15%** on sale (`net = 0.85 × sale`), fixed in code.

This model is **market-true**: it prices what the ingredients are worth, not what they cost *you* today. Mats already sitting in the bank are still priced at their TP `sell_price` here — pricing an owned-but-tradable mat at 0 would inflate ROI, because selling it instead is a real alternative. The owned-stock discount lives in §5 as a separate figure.

---

## 5. ROI ranking + shown figures

Two costings of the same tree, per row:

**Market-true (§4)** — drives the gates and the ROI figure:
- **Cost** (`craft_cost`) = ingredients acquired by instant-buy (each at its `sell_price`).
- **Revenue** (`list_revenue`) = output sold by *listing* = `sell_price × 0.85`.
- **Profit** = revenue − cost; **ROI** = profit / cost.

**Out-of-pocket** — the *same plan* the market-true pass chose, re-walked against a copy of the account's stock. Each node spends what inventory can cover and pays market price only for the shortfall; owning a mid-tree intermediate removes demand for its whole subtree, so the discount is recursive by construction. Credit is **partial** (1 of 3 Bolt of Damask pays for two) and the copy is **spent down as the walk consumes it**, so one stack cannot discount two branches at once:
- **`out_of_pocket`** = coin actually spent per output item.
- **`owned_value`** = `craft_cost − out_of_pocket` — market value of the held mats consumed.
- **`net_profit`** = `list_revenue − out_of_pocket`; **`net_roi_pct`** = net_profit / out_of_pocket (capped, undefined when nothing is spent).

**Rank = `net_profit` desc**, so a recipe whose mats are already in the bank outranks an otherwise-equal one. The gates (§6) deliberately keep judging the market-true figures: owning mats reorders recipes that already clear the bar, it never floats a break-even recipe onto the board.

Held stock is credited **per row independently** — the same 25 Mithril Ore discounts every recipe that consumes it, because each row answers "if I craft *this*, what do I pay?". The board ranks single crafts, not a joint plan, so this is an edge signal, not a budget. Within a single row it is a budget, and is enforced as one.

Also displayed per row (context, not ranking):
- **Instant-flip floor** = output dumped into buy order = `buy_price × 0.85`.
- **Optimal upside** = ingredients acquired via patient buy orders (`buy_price`).

---

## 6. Gates (all tunable via `vars` in `apps/cron/wrangler.jsonc` unless noted)

| Gate | Default | Meaning |
|---|---|---|
| output sellable | `sell_price > 0` | untradeable/bound items have no TP price ⇒ dropped (code) |
| demand velocity | `sell_sold_day ≥ 10` | real buyer throughput |
| supply overhang | `days_to_sell = sell_quantity / sell_sold_day ≤ 14` | won't sit forever. Was 7 until 2026-07-25; measured over 2758 scored known recipes, 7 admitted 0 and sat below the p10 (12.3d) of everything else qualifying — it was the binding gate, not velocity |
| ROI floor | `ROI ≥ 10%` | |
| profit floor | `profit ≥ 100` copper (1s) | filters dust |
| leaf obtainability | all leaves TP-buyable, coin-buyable, or free account-bound mat | §4, code |

---

## 7. Deployment

Migrated off k3s to Cloudflare on 2026-08-31 — see `docs/PLAN-cloudflare-migration.md` for the
measurements that reversed the earlier "keep the job in k3s" call. The k3s footprint is zero.

- **Two Workers, not one.**
  - `gw2-roi-cron` — `scheduled()` only, **no route and no custom domain**, so it has no public
    surface by construction rather than by policy. It holds `ARENA_NET_KEY` and makes the
    account-authenticated GW2 calls. A dashboard redeploy cannot disturb the hourly job.
  - `gw2-roi-web` — `fetch()` only, custom domain `gw2.itguys.ro`, reads D1 and renders.
  - Both bind the same D1 database. D1 bindings are not exclusive.
- **Schedule:** Cloudflare **Cron Trigger** `0 * * * *` on `gw2-roi-cron`. `scheduled()` is not an
  HTTP request, so it never passes through the Access edge.
- **No image.** wrangler bundles the TypeScript; there is no Dockerfile, no GHCR, no pull secret.
- **`nodejs_compat` is deliberately OFF** — a divergence from the sibling repos, which need it for
  Next.js/opennext. Nothing here requires it once `process.env` is gone, and it costs isolate
  startup against the hard 1 s limit.
- **CI:** two `dustfeather/shared-workflows/.github/workflows/deploy-cloudflare.yml@v4` callers on
  the in-cluster ARC runner `arc-df-gw2roi`, `deploy-web` gated on `deploy-cron` so the board never
  deploys against an unmigrated schema.
  - Migrations run once, as the cron job's `pre-deploy-command`, i.e. **before** the new code is
    live. Under the old inline-DDL model the first invocation after a deploy carried the DDL, so a
    schema failure surfaced as a failed *run* rather than a failed *deploy*.
  - `expect-crons: 0 * * * *` is what covers a cron-only Worker. `verify-url` has nothing to curl,
    and wrangler treats an absent `triggers` block as "leave whatever is registered alone" — so a
    misplaced or unread config section deploys green with zero schedules, and the failure only
    shows up an hour later as "the job never ran".
  - **`apps/cron` must deploy with plain `wrangler deploy`.** Under `wrangler versions upload`
    crons are applied only by a separate, still-experimental `wrangler triggers deploy`, so they
    would register never.
- **Secrets:** `ARENA_NET_KEY` stays a GitHub Actions Secret and is the single source of truth,
  shipped onto the Worker with the deploy via `WORKER_SECRETS` (wrangler `--secrets-file`, so the
  credentials attach to the version being uploaded rather than to a later one).

---

## 8. Storage — Cloudflare D1

One database, `gw2`. Six tables, all declared in `packages/core/schema.ts` (Drizzle) and applied
as numbered migrations from `drizzle/`.

| Table | Lifecycle |
|---|---|
| `craft_roi`, `craft_roi_learnable` | **latest-only** — DELETE + chunked INSERT per run, one `db.batch()` each, so the board is never observed half-written |
| `tp_transactions` | **accumulate-only** (insert-or-ignore by id), so history survives the API's ~90-day window |
| `account_balance` | **accumulate-only**, one wallet snapshot per run — `/v2/account/wallet` returns only the *current* balance, so this is the only balance history that will ever exist. Never truncate it. |
| `recipe_defs`, `item_defs` | self-maintaining definition caches: unseen ids plus a `RECIPE_REFRESH_PER_RUN` oldest-first slice per run |

Type mapping from the Postgres original: `bigint`→`INTEGER` (coin values and txn ids are far
inside 2^53), `double precision`→`REAL`, `jsonb`→`TEXT`, `timestamptz`→`INTEGER` epoch
**milliseconds**, `TRUNCATE`→`DELETE FROM`. `fmt_coin()` was a PL/pgSQL function; SQLite has no
stored functions, so it is `fmtCoin()` in `packages/core/fmt.ts` and formatting happens at render.

Two D1 limits shape the write path: **100 bound parameters per query** (so `craft_roi` inserts 5
rows at a time across 18 columns) and **`db.batch()` runs as one implicit transaction** (so the
DELETE and every INSERT for a table go in a single call). Definition upserts write `fetched_at` as
a SQL expression rather than a bound value, which doubles rows per statement.

Reads of the def caches are **full-table scans**, two queries a run. The old `WHERE id = ANY($1)`
in 5,000-id chunks was a Postgres artifact: the pipeline reads essentially the whole cache every
run, and SQLite has no array parameter.

---

## 9. UI — server-rendered board on `gw2.itguys.ro`

Grafana is gone. The board is `gw2-roi-web`: **Hono + JSX, server-rendered**, zero client
JavaScript, so the D1 binding, the queries and the whole ledger stay server-side.

- **Same five panels as the Grafana board, relaid out:** stat row across the top, full-width
  cumulative TP graph (inline SVG, generated server-side), then **CRAFTABLE NOW and LEARNABLE side
  by side**. The two-up row is deliberate — the velocity gates routinely leave three rows in one
  table, and stacking two of those under a full-width graph looks broken.
- **`net_profit` is the single rank key**: top-N selection in the pipeline, both table sorts, and
  the headline stat. Market-true `profit` is displayed but does not rank. ROI stays a gate and a
  displayed figure, never a rank key.
- **No time filter**, deliberately: `craft_roi` is latest-only, so every row shares one
  `updated_at` and there is nothing to filter across. The cumulative graph reads the
  accumulate-only tables and plots their whole history.
- Item links: the gw2efficiency crafting calculator by item id (known), the wiki recipe page by
  name (learnable — vendor and currency are not in the GW2 API at all).
- **Styling:** Tailwind, built by `@tailwindcss/cli` into a committed `.css.txt` and loaded as a
  Text module. One CSS file is the only static asset, so there is no `assets` binding.
- **Access:** the hostname is covered by its own Cloudflare Access application. This is a real
  exposure change — the Grafana host was an unproxied WARP-mesh address, unreachable from the
  internet by network topology, whereas on a Worker Access is the only control and the board
  renders `account_balance` and the full `tp_transactions` ledger.

---

## 10. Configuration surface

- **`vars` in `apps/cron/wrangler.jsonc`:** `TOP_N`, `TP_KEEP_RATIO`, `VELOCITY_WINDOW`, the four
  gate thresholds, `RECIPE_REFRESH_PER_RUN`. Coin-vendor and free-mat prices ship as bundled JSON
  (879 bytes of git-versioned constants, read every run — not in R2).
- **Worker secret:** `ARENA_NET_KEY`, from the GitHub Actions Secret of the same name.
- **Code-fixed:** recursion, 15% TP fee, request throttle, chunk sizes.

Config is built by `buildConfig(env)` **inside the handler**. Workers deliver env as a handler
argument and have no `process.env`, so there is no module-scope config const to read at import.

---

## 11. Run pipeline (per Cron Trigger invocation)

1. `buildConfig(env)` — throws on a missing key, which fails the invocation in milliseconds rather
   than after a full pipeline's worth of API calls.
2. GW2: pull characters → max discipline ratings; pull unlocked recipes + the full recipe id list;
   split into `known` (craftable now) and `learnable` (disciplines qualify, not unlocked).
3. Collect all output item ids + full ingredient closure ids.
4. datawars2: bulk-fetch prices + velocity for every id.
5. Load bundled coin-vendor + free-mat JSON tables (in-memory, no fetch). Free mats = account-bound
   bulk mats (Bloodstone Dust, Dragonite Ore, Empyreal Fragment) priced at 0 — can't be
   TP-bought/sold or crafted, accumulate for free.
6. Recursive cheapest-source cost per candidate; disqualify on bad leaves.
7. Compute market-true ROI, then re-walk the same plan for the out-of-pocket figures (§5).
8. Apply gates.
9. Sort by `net_profit` desc, take top-N.
10. DELETE + INSERT both ROI tables; append new transactions and one wallet snapshot.
11. The board reads D1 live on the next request.

---

## Resolved — infra probe 2026-07-23

**1. ghcr path + trading-ns SA rights** — ✅ resolved.
- Path `ghcr.io/dustfeather/<image>`. Pull secret `ghcr-pull` reusable (see §7). Refresher SUSPENDED (fine).
- Deploy RBAC = per-repo ARC runner SA + namespaced Role/RoleBinding; copy `alpaca-ci-deployer` (cronjobs+secrets verbs). **No gw2 SA yet — create at setup.**

**2. Grafana provisioning sidecar** — ✅ resolved: **does not exist.** Use fallback (edit provisioning ConfigMaps + `rollout restart`), and add both a **Postgres datasource** and a **dashboard provider** (neither present today). Details in §9.

**3. Coin-vendor mat table + selectors** — ✅ resolved, with a recommendation:
- The old coin+karma "Crafting Supplier" vendors were **removed 2016**. There is **no consolidated table** — data is per-item: each item's `## Acquisition` section (h2 `id=Acquisition`) → `<li>` linking `/wiki/Master_craftsman` with coin icons, often "per N". E.g. Thermocatalytic Reagent (id `46747`) = `14s 96c per 10` ≈ **150c/unit**.
- The coin-buyable set is **small (~30–40 items) and effectively static** (prices unchanged for years).
- **DECIDED: dropped Playwright/Chromium + the wiki scrape entirely** (Playwright had no other use — plain HTTP/JSON everywhere else). Coin-vendor prices ship as a bundled `{item_id: coin_per_unit}` JSON, sourced once from the wiki `## Acquisition` sections. Refresh (if ever needed) via a one-off maintenance script, not the hot path. Removes Chromium-in-image, the scrape stage, and the wiki cache.

## New finding
- **No Postgres in `trading`** yet (only chatwoot has its own). §8's dedicated StatefulSet must be provisioned at setup + Secret `gw2-postgres` creds. Table is tiny (latest-only TRUNCATE+INSERT) → single replica, minimal resources.

---

## Status — 2026-08-31 (migrated to Cloudflare)

The job, the database and the dashboard all moved to Cloudflare; §7–§11 above describe the shape
that is now live. What follows below is the k3s-era record, kept because the reasoning behind the
cost model and the gates is still the reasoning in force — only the deployment substrate changed.

Anything below this line describing a CronJob, a Postgres StatefulSet, GHCR or Grafana is
**historical**. The measurements that reversed the original "keep the job in k3s, reach D1 over
REST" decision are in `docs/PLAN-cloudflare-migration.md` §1.

---

## Status — 2026-07-23 (implemented & live, k3s era)

Bot **built, deployed, and confirmed writing to Postgres** end-to-end. Deploy run `29982787684` green; `craft_roi` populated live.

### ✅ Done

| Area | State |
|---|---|
| **Bun app** (`src/`) | config, gw2api (rate-limited, 429 backoff), datawars, coinVendor, cost (recursive cheapest-source + cycle guard + memo), roi (+ gates), db (pg Pool, DDL, TRUNCATE+INSERT), pipeline, index. Typecheck clean. |
| **Cost/ROI model** (§4–5) | implemented as specced: `min(TP-buy, craft, coin)`, 15% fee, craft-and-list ROI + instant-flip floor + optimal figures. |
| **Gates** (§6) | all 6 implemented, ConfigMap-tunable. |
| **Coin-vendor** (§4) | bundled `data/coin-vendor.json` — **only** Thermocatalytic Reagent `46747`@150c so far (rest fall back to TP). |
| **Image** | `Dockerfile` `oven/bun:1-alpine` multi-stage, no Playwright, `USER bun`. Pushed to `ghcr.io/dustfeather/gw2-crafting-roi-bot`. |
| **Storage** (§8) | `gw2-postgres` StatefulSet (postgres:17-alpine) + 1Gi PVC + headless Service. `craft_roi` table (recipe_id PK), latest-only. |
| **Schedule** (§7) | CronJob `gw2-crafting-roi` `0 * * * *`, ns `trading`, `imagePullSecrets: ghcr-pull`. |
| **CI/CD** | `build.yml` (GHCR push, github-hosted) → `deploy.yml` (`workflow_run`/dispatch) on **in-cluster ARC runner `arc-df-gw2roi`**. `checkout@v5`. |
| **Secrets = GitHub** | single source of truth. `deploy.yml` syncs `ARENA_NET_KEY` + `PG_PASSWORD` (GH Actions Secrets, set from gitignored `.env`) → k8s secrets `gw2-api-key` + `gw2-postgres-creds`. No plaintext in repo. |
| **RBAC** | `gw2-ci-deployer` Role in trading (cronjobs/jobs/secrets/configmaps + statefulsets get/list/watch) bound to SA `arc-df-gw2roi-gha-rs-no-permission`. |
| **Runner set** | `arc-df-gw2roi` (chart 0.14.1, min0/max2) in `k3s-cluster/bootstrap/arc-runner-sets.sh` + helm-installed. |
| **First-run** | `deploy.yml` waits PG rollout then kicks `gw2-roi-init` job → `craft_roi` populated on deploy, no wait for schedule. **Confirmed: 1 row, ROI ~15.6%.** |
| **Grafana** (§9) | **Live via HTTP API, local-run.** `scripts/provision-grafana.sh` (reads `.env`) upserts Postgres datasource `gw2-postgres` (health OK) + dashboard `gw2-craft-roi` from `k8s/grafana/dashboards/gw2-roi.json`. SA `ci-dashboard-push`. Not in CI. **Confirmed end-to-end: dashboard queries PG live, item-name search links** (`https://grafana.itguys.ro/d/gw2-craft-roi`). |

### ⏳ Remaining

1. **Observe a natural `0 * * * *` cron tick** refresh `craft_roi` unattended. On-demand runs are covered: `scripts/run-now.sh` spawns a Job from the CronJob template (identical image/spec), tails logs, verifies the row count, repushes the dashboard — confirmed working (fresh row, ROI 18.1%). Only the scheduled-firing itself is left to watch.
3. **Gate tuning** — only **1 recipe** clears gates at current prices. Loosen `configmap.yaml` gates for more candidates, or accept (GW2 TP genuinely has few profitable crafts). Judge once Grafana is up.
4. **Coin-vendor coverage** — expand `data/coin-vendor.json` beyond `46747` as more coin-buyable mats are confirmed; missing mats overprice crafts via TP fallback and hide real ROI.

### Deviations from original design
- **§7 image**: shipped `oven/bun:1-alpine` (not "node 26 + Bun") — Bun-only base, smaller, sidesteps the node-native-module concern entirely.
- **§7 RBAC naming**: SA convention confirmed `arc-df-<repo>-gha-rs-no-permission` (not `arc-<repo>-…`); Role is `gw2-ci-deployer` (own, not a copy of `alpaca-ci-deployer`).
- **§9 Grafana**: unchanged plan, deferred — not yet applied.
