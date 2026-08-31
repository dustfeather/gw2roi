#!/usr/bin/env bash
# Reseed the D1 definition caches (recipe_defs, item_defs) from the GW2 API.
#
# Run this MANUALLY after an expansion or a big content patch, or against a cold database.
# Normal operation does not need it: the hourly Worker always fetches ids the cache has never
# seen, and re-reads RECIPE_REFRESH_PER_RUN (600) of the oldest rows per run, so new recipes
# land on their own and the whole table turns over in about a day.
#
# Two modes:
#   bash scripts/seed-cache.sh              # resume: fetch only ids not already in .seed/
#   bash scripts/seed-cache.sh --refresh    # re-fetch EVERY definition (changed stats,
#                                           # renamed items, reworked recipes)
#
# Runs `scripts/seed-cache.ts` from this working copy (local Bun — it is not part of either
# Worker and is not deployed), then applies the SQL it emits with wrangler. Nothing is built and
# no image is involved; the seeder only writes cache tables the Worker already reads.
#
# Usage:  bash scripts/seed-cache.sh [--refresh]
# Env overrides: DB (D1 database name)
set -euo pipefail

DB="${DB:-gw2}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Only --refresh is meaningful; anything else is a typo worth catching before a 20-min run.
REFRESH=""
for a in "$@"; do
  case "$a" in
    --refresh) REFRESH="$a" ;;
    *) echo "!! unknown argument: $a (only --refresh is supported)" >&2; exit 2 ;;
  esac
done

command -v bun >/dev/null || { echo "!! bun not on PATH" >&2; exit 1; }
[ -d "$ROOT/node_modules" ] || { echo "!! run 'pnpm install' first" >&2; exit 1; }

# CLOUDFLARE_API_TOKEN for the wrangler calls below; ARENA_NET_KEY is not needed (recipes and
# items are public endpoints) but is picked up if it happens to be there.
if [ -f "$ROOT/.env" ]; then set -a; . "$ROOT/.env"; set +a; fi

echo ">> fetching definitions (${REFRESH:-resume mode}) — 10-20 min cold, safe to interrupt and re-run"
(cd "$ROOT" && bun run scripts/seed-cache.ts ${REFRESH:+"$REFRESH"})

for table in recipe_defs item_defs; do
  echo ">> applying .seed/${table}.sql to D1 '${DB}'"
  (cd "$ROOT" && npx wrangler d1 execute "$DB" --remote --file ".seed/${table}.sql")
done

echo ">> cache state now:"
(cd "$ROOT" && npx wrangler d1 execute "$DB" --remote --command \
  "SELECT 'recipe_defs' AS t, count(*) AS rows, min(fetched_at) AS oldest FROM recipe_defs
   UNION ALL
   SELECT 'item_defs', count(*), min(fetched_at) FROM item_defs;")
