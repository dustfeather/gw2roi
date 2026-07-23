# Secrets — GitHub is the single source of truth

Cluster secrets are **never** committed and **never** applied by hand. They live as
**GitHub Actions Secrets** and are pushed into the `trading` namespace by
`.github/workflows/deploy.yml`, which runs on the in-cluster ARC runner
(`arc-df-gw2roi`, SA bound to the `gw2-ci-deployer` Role with `secrets` verbs).

## Required GitHub Actions Secrets

| GitHub Secret   | → k8s Secret          | Keys created                                              |
| --------------- | --------------------- | -------------------------------------------------------- |
| `ARENA_NET_KEY` | `gw2-api-key`         | `ARENA_NET_KEY`                                           |
| `PG_PASSWORD`   | `gw2-postgres-creds`  | `POSTGRES_USER/DB/PASSWORD` + `PGUSER/PGDATABASE/PGPASSWORD` |

`gw2-postgres-creds` is consumed by **both** the Postgres StatefulSet and the bot
CronJob. `POSTGRES_USER`/`DB` are non-secret literals (`gw2`); only the password
comes from GitHub.

## Set them

```sh
gh secret set ARENA_NET_KEY   # paste ArenaNet key (account,characters,unlocks,inventories)
gh secret set PG_PASSWORD     # paste a strong password
```

Rotate = update the GitHub Secret, then re-run the `deploy` workflow. The Grafana
datasource password (`k8s/grafana/datasource.yaml`) must match `PG_PASSWORD`.

## Not secret-managed here (admin bootstrap, once)

`k8s/rbac.yaml`, `k8s/postgres.yaml`, and the `arc-df-gw2roi` runner scale set —
the deployer Role deliberately lacks `statefulsets`/`serviceaccounts` verbs.
