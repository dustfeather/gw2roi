#!/usr/bin/env bash
# Cutover step 1 (docs/PLAN-cloudflare-migration.md §7): dump the four live Postgres tables as
# SQLite-compatible INSERT statements, ready for `wrangler d1 execute --file`.
#
# Run this ONCE, from a machine with a kubeconfig for the k3s cluster, while the old CronJob is
# still writing. Output:
#
#   cutover/tp_transactions.sql   1.9k rows — COMMITTED to the repo
#   cutover/account_balance.sql   660 rows  — COMMITTED to the repo
#   .seed/recipe_defs.sql         13.2k rows — gitignored (9.6 MB)
#   .seed/item_defs.sql           14k rows   — gitignored (15 MB)
#
# The two small ones are committed because they are IRREPLACEABLE: /v2/account/wallet returns
# only the current balance, so account_balance is the only balance history that will ever exist,
# and tp_transactions outlives the API's ~90-day window. The def caches are not — they can always
# be refetched with scripts/seed-cache.sh, which is why 25 MB of them stays out of git.
#
# Timestamps are converted to epoch MILLISECONDS here, matching the D1 schema (§4).
#
# Escaping note: text is quoted by doubling single quotes rather than with `quote_literal()`.
# Postgres emits an `E'...'` prefix when a string contains a backslash, and SQLite rejects that —
# item names and JSON definitions contain plenty of backslashes.
#
# Usage:  bash scripts/export-pg.sh
# Env overrides: KCTX (kube context), NS (namespace), LOCAL_PORT
set -euo pipefail

KCTX="${KCTX:-k3s-itguys}"
NS="${NS:-trading}"
LOCAL_PORT="${LOCAL_PORT:-15432}" # not 5432, so a local postgres can keep its port
K=(kubectl --context "$KCTX" -n "$NS")
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v psql >/dev/null || { echo "!! psql not on PATH" >&2; exit 1; }
mkdir -p "$ROOT/cutover" "$ROOT/.seed"

echo ">> reading postgres credentials from secret/gw2-postgres-creds"
d() { "${K[@]}" get secret gw2-postgres-creds -o "jsonpath={.data.$1}" | base64 -d; }
PGUSER="$(d PGUSER)"
PGPASSWORD="$(d PGPASSWORD)"
PGDATABASE="$(d PGDATABASE)"
export PGPASSWORD

echo ">> port-forwarding svc/gw2-postgres to localhost:${LOCAL_PORT}"
"${K[@]}" port-forward svc/gw2-postgres "${LOCAL_PORT}:5432" >/dev/null 2>&1 &
PF_PID=$!
cleanup() { kill "$PF_PID" >/dev/null 2>&1 || true; }
trap cleanup EXIT
for _ in $(seq 1 20); do
  (exec 3<>"/dev/tcp/127.0.0.1/${LOCAL_PORT}") 2>/dev/null && break
  sleep 0.5
done
kill -0 "$PF_PID" 2>/dev/null || { echo "!! port-forward died — is the cluster reachable?" >&2; exit 1; }

pg() { psql -h 127.0.0.1 -p "$LOCAL_PORT" -U "$PGUSER" -d "$PGDATABASE" -At -c "$1"; }

# One statement per row. Verbose for 27k definition rows, but `wrangler d1 execute --file` streams
# the file (5 GB limit) and this runs exactly once, so batching them would be complexity spent on
# a path that is walked one time.
q() { echo "'''' || replace($1::text, '''', '''''') || ''''"; }
ms() { echo "(extract(epoch from $1)*1000)::bigint"; }

echo ">> cutover/tp_transactions.sql"
pg "COPY (SELECT 'INSERT INTO tp_transactions (id,item_id,kind,price,quantity,purchased_at) VALUES ('
  || id || ',' || item_id || ',' || $(q kind) || ',' || price || ',' || quantity || ','
  || $(ms purchased_at) || ') ON CONFLICT(id) DO NOTHING;'
  FROM tp_transactions ORDER BY id) TO STDOUT" > "$ROOT/cutover/tp_transactions.sql"

echo ">> cutover/account_balance.sql"
pg "COPY (SELECT 'INSERT INTO account_balance (recorded_at,coin) VALUES ('
  || $(ms recorded_at) || ',' || coin || ') ON CONFLICT(recorded_at) DO NOTHING;'
  FROM account_balance ORDER BY recorded_at) TO STDOUT" > "$ROOT/cutover/account_balance.sql"

for table in recipe_defs item_defs; do
  echo ">> .seed/${table}.sql"
  pg "COPY (SELECT 'INSERT INTO ${table} (id,def,fetched_at) VALUES ('
    || id || ',' || $(q def) || ',' || $(ms fetched_at) || ')
    ON CONFLICT(id) DO UPDATE SET def=excluded.def, fetched_at=excluded.fetched_at;'
    FROM ${table} ORDER BY id) TO STDOUT" > "$ROOT/.seed/${table}.sql"
done

echo
echo ">> row counts:"
wc -l "$ROOT/cutover/tp_transactions.sql" "$ROOT/cutover/account_balance.sql" \
      "$ROOT/.seed/recipe_defs.sql" "$ROOT/.seed/item_defs.sql"
echo
echo "Next: create the D1 database, apply migrations, then import — defs FIRST, so the first"
echo "Worker run never takes the cold-cache path (§1, the 858 s regime):"
echo "  npx wrangler d1 execute gw2 --remote --file .seed/item_defs.sql"
echo "  npx wrangler d1 execute gw2 --remote --file .seed/recipe_defs.sql"
echo "  npx wrangler d1 execute gw2 --remote --file cutover/tp_transactions.sql"
echo "  npx wrangler d1 execute gw2 --remote --file cutover/account_balance.sql"
