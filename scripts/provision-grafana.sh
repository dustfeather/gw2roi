#!/usr/bin/env bash
# Idempotent Grafana provisioning via HTTP API.
#   - upserts the Postgres datasource (uid: gw2-postgres) pointing at the
#     dedicated gw2-postgres StatefulSet in the trading ns
#   - upserts the "GW2 Crafting ROI" dashboard (uid: gw2-craft-roi)
#
# Runs from CI (deploy.yml) and locally. Reruns are safe (create-or-update).
#
# Required env:
#   GRAFANA_API_KEY   service-account token / API key with editor+datasource rights
#   PG_PASSWORD       password for the gw2 Postgres role (same as gw2-postgres-creds)
# Optional env (defaults shown):
#   GRAFANA_URL=https://grafana.itguys.ro
#   PG_HOST=gw2-postgres.trading.svc.cluster.local:5432
#   PG_USER=gw2
#   PG_DB=gw2
set -euo pipefail

GRAFANA_URL="${GRAFANA_URL:-https://grafana.itguys.ro}"
PG_HOST="${PG_HOST:-gw2-postgres.trading.svc.cluster.local:5432}"
PG_USER="${PG_USER:-gw2}"
PG_DB="${PG_DB:-gw2}"
DS_UID="gw2-postgres"

: "${GRAFANA_API_KEY:?missing GRAFANA_API_KEY}"
: "${PG_PASSWORD:?missing PG_PASSWORD}"
command -v jq >/dev/null || { echo "jq required"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH_JSON="$SCRIPT_DIR/../k8s/grafana/dashboards/gw2-roi.json"
test -f "$DASH_JSON" || { echo "dashboard JSON not found: $DASH_JSON"; exit 1; }
# Fail fast on malformed dashboard JSON before touching Grafana.
jq empty "$DASH_JSON" >/dev/null 2>&1 || { echo "dashboard JSON invalid: $DASH_JSON"; jq empty "$DASH_JSON"; exit 1; }

AUTH=(-H "Authorization: Bearer ${GRAFANA_API_KEY}" -H "Content-Type: application/json")
api() { curl -sS -m 30 "${AUTH[@]}" "$@"; }

echo ">> Grafana: ${GRAFANA_URL} ($(api "${GRAFANA_URL}/api/health" | jq -r .version))"

# --- Datasource (create-or-update by uid) --------------------------------
ds_payload() {
  jq -n \
    --arg uid "$DS_UID" --arg url "$PG_HOST" --arg user "$PG_USER" \
    --arg db "$PG_DB" --arg pw "$PG_PASSWORD" \
    '{
      uid: $uid, name: "GW2-Postgres", type: "postgres", access: "proxy",
      url: $url, user: $user, database: $db, isDefault: false,
      jsonData: { database: $db, sslmode: "disable", postgresVersion: 1700,
                  maxOpenConns: 2, timescaledb: false },
      secureJsonData: { password: $pw }
    }'
}

# Best-effort: a dashboard-scoped service account lacks datasources:create/write.
# If so we warn and continue — the datasource is a one-time admin bootstrap
# (see README / provision note); the dashboard below references it by uid.
existing="$(api -o /dev/null -w '%{http_code}' "${GRAFANA_URL}/api/datasources/uid/${DS_UID}")"
if [ "$existing" = "200" ]; then
  id="$(api "${GRAFANA_URL}/api/datasources/uid/${DS_UID}" | jq -r .id)"
  echo ">> datasource ${DS_UID} exists (id=${id}) -> update"
  code="$(api -o /tmp/ds_resp -w '%{http_code}' -X PUT "${GRAFANA_URL}/api/datasources/${id}" -d "$(ds_payload)")"
else
  echo ">> datasource ${DS_UID} absent -> create"
  code="$(api -o /tmp/ds_resp -w '%{http_code}' -X POST "${GRAFANA_URL}/api/datasources" -d "$(ds_payload)")"
fi
if [ "$code" = "200" ] || [ "$code" = "201" ]; then
  echo ">> datasource ok: $(jq -r '.message // .datasource.name // "ok"' /tmp/ds_resp 2>/dev/null)"
  ds_id="$(api "${GRAFANA_URL}/api/datasources/uid/${DS_UID}" | jq -r .id)"
  health="$(api "${GRAFANA_URL}/api/datasources/${ds_id}/health" || true)"
  echo ">> datasource health: $(echo "$health" | jq -r '.status // "unknown"') - $(echo "$health" | jq -r '.message // ""')"
else
  echo "!! datasource upsert skipped (HTTP ${code}): $(jq -r '.message // "no datasources permission"' /tmp/ds_resp 2>/dev/null)"
  echo "!! bootstrap it once with an admin token (see scripts/provision-grafana.sh header / README)."
fi

# --- Dashboard (create-or-update, overwrite by uid) ----------------------
echo ">> upserting dashboard gw2-craft-roi"
jq -n --slurpfile d "$DASH_JSON" \
  '{ dashboard: ($d[0] + {id: null}), overwrite: true, message: "provisioned by gw2 repo" }' \
  | api -X POST "${GRAFANA_URL}/api/dashboards/db" -d @- \
  | jq -r '"   " + (.status // "?") + " -> " + (.url // .message // "")'

echo ">> done"
