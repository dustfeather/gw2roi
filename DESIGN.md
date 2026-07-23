# GW2 Crafting-ROI Bot — Design

Surfaces the **top-N craftable items by ROI**, hourly, into Grafana. Every decision below was resolved in the `/grill-me` interview.

---

## 1. Goal

For recipes I can craft *right now*, rank by return on investment (craft cost vs. sell revenue), keeping only items with **real, sellable demand**. Emit top-N to a dashboard.

---

## 2. Data sources

| Source | Use | Notes |
|---|---|---|
| **GW2 official API v2** (`api.guildwars2.com`) | recipes, unlocks, characters, item flags, listing depth | Bearer key from `.env` `ARENA_NET_KEY`; `?v=latest`; retry on random "invalid key" |
| **datawars2** (`api.datawars2.ie/gw2/v1/items/json`) | prices + velocity | bulk `ids=`, no bot protection; `buy_price/sell_price/buy_quantity/sell_quantity/1d_sell_sold` |
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

For each ingredient, `cost = min( buy-on-TP, craft-it, buy-from-coin-vendor )`, computed recursively.

- **Leaf validity:** an ingredient is acceptable only if it is a **TP-buyable Item** (`sell_price > 0`) **OR** a **coin-vendor mat** (present in the hardcoded coin-price JSON).
- **Disqualify the whole recipe** if any leaf is `Currency`, `GuildUpgrade`, karma, or otherwise not obtainable for gold/TP.
- TP fee: **15%** on sale (`net = 0.85 × sale`), fixed in code.

---

## 5. ROI ranking + shown figures

Primary rank = **Craft-and-list** ROI:
- **Cost** = ingredients acquired by instant-buy (each at its `sell_price`).
- **Revenue** = output sold by *listing* = `sell_price × 0.85`.
- **ROI** = (revenue − cost) / cost. Rank **desc**.

Also displayed per row (context, not ranking):
- **Instant-flip floor** = output dumped into buy order = `buy_price × 0.85`.
- **Optimal upside** = ingredients acquired via patient buy orders (`buy_price`).

---

## 6. Gates (all ConfigMap-tunable unless noted)

| Gate | Default | Meaning |
|---|---|---|
| output sellable | `sell_price > 0` | untradeable/bound items have no TP price ⇒ dropped (code) |
| demand velocity | `1d_sell_sold ≥ 10` | real buyer throughput |
| supply overhang | `days_to_sell = sell_quantity / 1d_sell_sold ≤ 7` | won't sit forever |
| ROI floor | `ROI ≥ 10%` | |
| profit floor | `profit ≥ 100` copper (1s) | filters dust |
| leaf obtainability | all leaves TP-buyable, coin-buyable, or free account-bound mat | §4, code |

---

## 7. Deployment

- **Schedule:** k3s **CronJob**, `0 * * * *` (hourly), namespace `trading`.
- **Image:** **node 26 + Bun runtime**, pushed to **ghcr.io**. No browser — plain HTTP + JSON only, so image stays small.
  - Pure-JS `pg` (no `pg-native`) — sidesteps node26 native-module break.
  - Native `fetch` for HTTP (GW2 API + datawars2).
  - Coin-vendor prices from bundled JSON — no scrape at runtime.
- **Tag:** `:latest`, `imagePullPolicy: Always`.
- **Build:** GitHub Actions on the self-hosted **ARC runner** → push ghcr.
- **Manifest apply:** `kubectl apply` / `set image` **from the ARC runner** (in-cluster SA). Mirrors the `rebalance` bot.
  - **RBAC pattern (confirmed 2026-07-23):** each repo gets a dedicated ARC runner SA `arc-<repo>-gha-rs-no-permission` in `arc-runners` + a namespaced Role/RoleBinding in `trading`. Copy the existing `alpaca-ci-deployer` Role (verbs `get,list,create,update,patch,delete` on `batch/cronjobs`; `get,create,update,patch` on `secrets`) — it already fits a CronJob-only deploy, no `deployments` verbs needed. **No gw2 runner SA exists yet** → create the runner scale set + `gw2-ci-deployer` Role/RoleBinding at setup.
- **Registry path:** `ghcr.io/dustfeather/<image>` (ghcr-pull owner = `dustfeather`).
- **Registry auth:** reuse `secret/ghcr-pull` (dockerconfigjson, in `trading`, 54d). `cronjob/ghcr-refresh` (`node:24-alpine`, `node /scripts/refresh.cjs`) is **currently SUSPENDED** — ghcr-pull is a long-lived PAT dockerconfig, so the refresher is only needed if that PAT rotates. Un-suspend only if pulls start 401'ing.

---

## 8. Storage

- **Dedicated Postgres 17**, `trading` ns: **StatefulSet + 1Gi PVC + creds Secret**, single replica.
- **Single table**, `CREATE TABLE IF NOT EXISTS` on boot; **TRUNCATE + INSERT** each run (**latest-only**, no history).

Proposed columns: `item_id, name, discipline, roi_pct, cost_copper, revenue_copper, profit_copper, sell_price, buy_price, instant_flip_copper, optimal_cost_copper, days_to_sell, sell_velocity, sell_supply, computed_at`.

---

## 9. UI — Grafana (implemented via HTTP API)

- Grafana in `monitoring` ns, `grafana/grafana:12.3.1`, **Helm-managed** (grafana chart 10.5.15) — single `grafana` container, **no provisioning sidecar**. Because it's Helm-managed, any hand-edit to the `grafana` datasources ConfigMap is reverted on the next `helm upgrade`, so the ConfigMap route was **dropped**.
- **Real path = Grafana HTTP API**, driven by `scripts/provision-grafana.sh` (idempotent create-or-update). Uses service account token `ci-dashboard-push` (`GRAFANA_API_KEY`). SA granted `datasources:create/write` + dashboard rights.
  - **Postgres datasource** uid `gw2-postgres`, url `gw2-postgres.trading.svc.cluster.local:5432`, db/user `gw2`, `sslmode=disable`, password = `PG_PASSWORD`. Script health-checks Grafana→PG after upsert.
  - **Dashboard** uid `gw2-craft-roi`, model in `k8s/grafana/dashboards/gw2-roi.json` (canonical), pushed via `POST /api/dashboards/db` overwrite. Stat row (count / best ROI / last-updated) + table panel `ORDER BY roi_pct DESC`. Item name column links to a GW2Efficiency TP **name search** (`?filter.search.term=<name:percentencode>`) — the bot resolves output item names (`/v2/items`) for the top-N and stores `output_item_name`.
  - **Run locally on demand**, not from CI: `set -a; . ./.env; set +a; bash scripts/provision-grafana.sh`. Dashboards persist in Grafana + in git (`k8s/grafana/dashboards/`); CI stays out of Grafana. No `GRAFANA_API_KEY` GH secret.
  - Stale `k8s/grafana/*.yaml` (ConfigMap datasource + dashboard-provider) kept only as the sidecar-based fallback; not applied.

---

## 10. Configuration surface

- **ConfigMap:** gate thresholds (`min_sell_sold`, `max_days_to_sell`, `min_roi_pct`, `min_profit_copper`), `top_n`, discipline whitelist, static recipe/item cache TTLs. Coin-vendor mat prices ship as a bundled JSON (in-image, no TTL).
- **Secret:** `ARENA_NET_KEY`, Postgres creds.
- **Code-fixed:** recursion, 15% TP fee, log level, dry-run flag.

---

## 11. Run pipeline (per CronJob execution)

1. Load config (env/ConfigMap) + secrets.
2. GW2: pull characters → max discipline ratings; pull unlocked + searchable recipes; filter to craftable-now set.
3. Collect all output item ids + full ingredient closure ids.
4. datawars2: bulk-fetch prices + velocity for every id.
5. Load bundled coin-vendor + free-mat JSON tables (in-memory, no fetch). Free mats = account-bound bulk mats (Bloodstone Dust, Dragonite Ore, Empyreal Fragment) priced at 0 — can't be TP-bought/sold or crafted, accumulate for free.
6. Recursive cheapest-source cost per candidate; disqualify on bad leaves.
7. Compute ROI + instant-flip + optimal figures.
8. Apply gates.
9. Sort desc, take top-N.
10. `TRUNCATE` + `INSERT` into Postgres.
11. Grafana reads live.

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

## Status — 2026-07-23 (implemented & live)

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
