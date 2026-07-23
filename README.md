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

```sh
# 1. Secrets (fill in real values first — secrets.example.yaml is a template)
kubectl apply -f k8s/secrets.example.yaml

# 2. Postgres
kubectl apply -f k8s/postgres.yaml

# 3. Config + CronJob
kubectl apply -f k8s/configmap.yaml -f k8s/cronjob.yaml

# 4. CI deploy RBAC — EDIT the runner SA in rbac.yaml first (no gw2 SA exists yet)
kubectl apply -f k8s/rbac.yaml

# 5. Grafana provisioning (no sidecar today → mount + rollout restart; EDIT namespace)
kubectl apply -f k8s/grafana/
kubectl -n monitoring rollout restart deploy/grafana

# manual run
kubectl -n trading create job --from=cronjob/gw2-crafting-roi gw2-roi-manual
```

## Setup notes (from DESIGN.md, unresolved until you fill them)

- **`rbac.yaml`**: set the ARC runner ServiceAccount name/namespace (no `gw2` SA exists yet — mirror `alpaca-ci-deployer`).
- **`secrets.example.yaml`**: real `ARENA_NET_KEY` + Postgres password. Never commit real values.
- **`k8s/grafana/*`**: set the Grafana namespace and the datasource password. Grafana has **no provisioning sidecar** — mount these ConfigMaps into Grafana's provisioning dirs and `rollout restart`.
- **`ghcr-refresh`** cron is suspended; only un-suspend if pulls start 401'ing.
- **`data/coin-vendor.json`**: only the confirmed Thermocatalytic Reagent (`46747` @ 150c) is bundled. Add more coin-buyable mats as confirmed — anything missing just falls back to TP pricing.
