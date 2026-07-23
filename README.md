# GW2 Crafting-ROI Bot

Ranks the **top-N craftable items by ROI** and writes them to Postgres for Grafana.
Runs hourly as a k3s CronJob. Design: [`DESIGN.md`](./DESIGN.md).

## What it does (one run)

1. Pull account discipline ratings, unlocked recipes, and the full recipe list (GW2 API).
2. Filter to the **craftable-now** set (discipline rating ≥ `min_rating`, and unlocked or `AutoLearned`).
3. Collect every output + ingredient item id across that set.
4. Bulk-fetch TP prices + velocity from datawars2.
5. Load bundled coin-vendor mat table (`data/coin-vendor.json`, in-memory).
6. Recursive cheapest-source cost per candidate: `min(TP instant-buy, craft-it, coin-vendor)`.
7. Compute ROI, instant-flip floor, and optimal (buy-order) figures.
8. Apply gates (§6).
9. Sort by ROI desc, take top-N.
10. `TRUNCATE` + `INSERT` into `craft_roi`.
11. Grafana reads live.

## Local run

```sh
bun install
ARENA_NET_KEY=... DATABASE_URL=postgres://gw2:pw@localhost/gw2 bun run start
```

Tuning env (defaults in `src/config.ts` / `k8s/configmap.yaml`): `TOP_N`, `TP_KEEP_RATIO`,
`GATE_MIN_SELL_SOLD_1D`, `GATE_MAX_DAYS_TO_SELL`, `GATE_MIN_ROI_PCT`, `GATE_MIN_PROFIT_COPPER`.

## Deploy

Namespace `trading`. Registry `ghcr.io/dustfeather/gw2-crafting-roi-bot` (pull secret `ghcr-pull`).

**GitHub is the single source of truth for secrets** — they are set as GitHub Actions
Secrets and pushed to the cluster by CI (`.github/workflows/deploy.yml`), never applied
by hand. See [`k8s/SECRETS.md`](./k8s/SECRETS.md).

### Bootstrap once (admin kubeconfig — the deployer Role can't do these)

```sh
kubectl apply -f k8s/rbac.yaml       # gw2-ci-deployer Role/RoleBinding
kubectl apply -f k8s/postgres.yaml   # dedicated Postgres 17 (StatefulSet + PVC + Service)
# + create the arc-df-gw2roi ARC runner scale set (mirror an existing arc-df-* repo)
```

### GitHub Secrets → cluster (CI-driven)

```sh
gh secret set ARENA_NET_KEY   # ArenaNet key
gh secret set PG_PASSWORD     # Postgres password (must match grafana datasource)
```

`deploy.yml` runs on the `arc-df-gw2roi` runner after each successful build: it creates
`gw2-api-key` + `gw2-postgres-creds` from those GitHub Secrets, then applies the
ConfigMap + CronJob. Trigger manually with `gh workflow run deploy.yml`.

### Grafana provisioning + manual run

```sh
# No provisioning sidecar today → mount these + rollout restart (EDIT namespace + password)
kubectl apply -f k8s/grafana/
kubectl -n monitoring rollout restart deploy/grafana

# kick an immediate run instead of waiting for the hourly schedule
kubectl -n trading create job --from=cronjob/gw2-crafting-roi gw2-roi-manual
```

## Setup notes (from DESIGN.md, unresolved until you fill them)

- **Runner scale set** `arc-df-gw2roi` doesn't exist yet — create it at bootstrap (mirror an existing `arc-df-*` repo); its SA is already referenced in `rbac.yaml`.
- **Secrets**: set `ARENA_NET_KEY` + `PG_PASSWORD` as GitHub Actions Secrets (see `k8s/SECRETS.md`). Never commit real values.
- **`k8s/grafana/*`**: set the Grafana namespace and the datasource password (= `PG_PASSWORD`). Grafana has **no provisioning sidecar** — mount these ConfigMaps into Grafana's provisioning dirs and `rollout restart`.
- **`ghcr-refresh`** cron is suspended; only un-suspend if pulls start 401'ing.
- **`data/coin-vendor.json`**: only the confirmed Thermocatalytic Reagent (`46747` @ 150c) is bundled. Add more coin-buyable mats as confirmed — anything missing just falls back to TP pricing.
