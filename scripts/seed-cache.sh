#!/usr/bin/env bash
# Reseed the Postgres definition caches (recipe_defs, item_defs) from the GW2 API.
#
# Run this MANUALLY after an expansion or a big content patch. Normal operation does not
# need it: the hourly bot always fetches ids the cache has never seen, and re-reads
# RECIPE_REFRESH_PER_RUN (600) of the oldest rows per run, so new recipes land on their own
# and the whole table turns over in about a day.
#
# Two modes:
#   bash scripts/seed-cache.sh              # resume: fetch only ids not already cached
#   bash scripts/seed-cache.sh --refresh    # re-fetch EVERY definition (changed stats,
#                                           # renamed items, reworked recipes)
#
# Runs `scripts/seed-cache.ts` from this working copy against the in-cluster Postgres, over a
# port-forward this script opens and closes. Nothing is deployed and no image is involved —
# the seeder only writes cache tables the running bot already reads.
#
# Usage:  bash scripts/seed-cache.sh [--refresh]
# Env overrides: KCTX (kube context), NS (namespace), LOCAL_PORT
set -euo pipefail

KCTX="${KCTX:-k3s-itguys}"
NS="${NS:-trading}"
LOCAL_PORT="${LOCAL_PORT:-15432}" # not 5432, so a local postgres can keep its port
K=(kubectl --context "$KCTX" -n "$NS")
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Only --refresh is meaningful; anything else is a typo worth catching before a 20-min run.
REFRESH=""
for a in "$@"; do
  case "$a" in
    --refresh) REFRESH="$a" ;;
    *) echo "!! unknown argument: $a (only --refresh is supported)" >&2; exit 2 ;;
  esac
done

command -v bun >/dev/null || { echo "!! bun not on PATH" >&2; exit 1; }
[ -d "$SCRIPT_DIR/../node_modules/pg" ] || { echo "!! run 'bun install' first" >&2; exit 1; }

echo ">> reading postgres credentials from secret/gw2-postgres-creds"
d() { "${K[@]}" get secret gw2-postgres-creds -o "jsonpath={.data.$1}" | base64 -d; }
PGUSER="$(d PGUSER)"
PGPASSWORD="$(d PGPASSWORD)"
PGDATABASE="$(d PGDATABASE)"

echo ">> port-forwarding svc/gw2-postgres to localhost:${LOCAL_PORT}"
"${K[@]}" port-forward svc/gw2-postgres "${LOCAL_PORT}:5432" >/dev/null 2>&1 &
PF_PID=$!
cleanup() { kill "$PF_PID" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Give the tunnel a moment, then confirm it actually came up — a dead port-forward otherwise
# surfaces as a confusing connect timeout 10s into the seeder.
for _ in $(seq 1 20); do
  (exec 3<>"/dev/tcp/127.0.0.1/${LOCAL_PORT}") 2>/dev/null && break
  sleep 0.5
done
kill -0 "$PF_PID" 2>/dev/null || { echo "!! port-forward died — is the cluster reachable?" >&2; exit 1; }

echo ">> seeding (${REFRESH:-resume mode}) — 10-20 min cold, safe to interrupt and re-run"
# No ARENA_NET_KEY needed for the fetches themselves (recipes and items are public), but
# src/config.ts builds `config` at module load and throws without it, so pass whatever is in
# .env and fall back to a placeholder.
if [ -f "$SCRIPT_DIR/../.env" ]; then set -a; . "$SCRIPT_DIR/../.env"; set +a; fi
PGHOST=127.0.0.1 PGPORT="$LOCAL_PORT" \
PGUSER="$PGUSER" PGPASSWORD="$PGPASSWORD" PGDATABASE="$PGDATABASE" \
ARENA_NET_KEY="${ARENA_NET_KEY:-unused-public-endpoints-only}" \
  bun run "$SCRIPT_DIR/seed-cache.ts" ${REFRESH:+"$REFRESH"}

echo ">> cache state now:"
"${K[@]}" exec statefulset/gw2-postgres -- \
  psql -U "$PGUSER" -d "$PGDATABASE" -At -c \
  "SELECT 'recipe_defs '||count(*)||' rows, oldest '||min(fetched_at) FROM recipe_defs
   UNION ALL
   SELECT 'item_defs   '||count(*)||' rows, oldest '||min(fetched_at) FROM item_defs;"
