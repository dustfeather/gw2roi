# GW2 Crafting-ROI Bot

Ranks the **top-N craftable items by profit per craft** and renders them on a board at
`gw2.itguys.ro`. Runs hourly as a Cloudflare Cron Trigger, over D1.
Design: [`DESIGN.md`](./DESIGN.md).

```
apps/cron/      gw2-roi-cron   scheduled() only, no route — computes and writes
apps/web/       gw2-roi-web    fetch() only, gw2.itguys.ro behind Access — reads and renders
packages/core/  cost model, gates, pipeline, D1 schema — imported by both
drizzle/        generated migrations, applied by wrangler before each deploy
data/           bundled coin-vendor + free-mat price tables
scripts/        seed-cache.{ts,sh} — manual definition-cache reseed, local Bun
```

## What it does (one run)

1. Pull account discipline ratings, unlocked recipes, and the full recipe list (GW2 API).
2. Split into **known** (craftable now) and **learnable** (disciplines qualify, recipe not unlocked).
3. Collect every output + ingredient item id across both sets.
4. Bulk-fetch TP prices + velocity from datawars2.
5. Load bundled coin-vendor + free-mat tables (`data/*.json`, in-memory).
6. Recursive cheapest-source cost per candidate: `min(TP instant-buy, craft-it, coin-vendor, spend-held-stock)`.
7. Compute market-true ROI, then re-walk the same plan against held stock for the out-of-pocket figures.
8. Apply gates (§6).
9. Sort by `net_profit` desc, take top-N. (ROI is a gate and a displayed figure, not the rank key —
   ranking by ROI favours cheap crafts worth a few copper each.)
10. Replace `craft_roi` + `craft_roi_learnable`; append new transactions and one wallet snapshot.
11. The board reads D1 live.

## Develop

```sh
pnpm install
pnpm typecheck                     # the only check this repo has
pnpm db:generate                   # after editing packages/core/schema.ts
pnpm --filter @gw2/web build:css   # after adding Tailwind classes; the output is committed
```

Tuning (defaults in `packages/core/config.ts`, live values in `apps/cron/wrangler.jsonc` `vars`):
`TOP_N`, `TP_KEEP_RATIO`, `VELOCITY_WINDOW` (`1d`/`2d`/`7d`, default `7d`),
`GATE_MIN_SELL_SOLD_DAY`, `GATE_MAX_DAYS_TO_SELL`, `GATE_MIN_ROI_PCT`, `GATE_MIN_PROFIT_COPPER`,
`RECIPE_REFRESH_PER_RUN`.

Demand velocity is averaged over `VELOCITY_WINDOW` and always expressed **per day**, so the gates
keep their units whichever window is selected. A 1-day window swings ~0.6x-3x run to run on thin
items, which flickers recipes on and off the board.

## Deploy

Push to `main` → [`deploy.yml`](./.github/workflows/deploy.yml): typecheck, then `gw2-roi-cron`
(migrations first, cron triggers asserted after), then `gw2-roi-web`. Both through
`dustfeather/shared-workflows`' `deploy-cloudflare.yml@v4` on the ARC runner `arc-df-gw2roi`.

**GitHub is the single source of truth for secrets** — `ARENA_NET_KEY` is a GitHub Actions Secret
and ships onto the Worker with the deploy. Never `wrangler secret put` by hand.

```sh
gh secret set ARENA_NET_KEY        # account,characters,unlocks,inventories,tradingpost,wallet
gh secret set CLOUDFLARE_API_TOKEN # Workers + D1 edit
gh secret set CLOUDFLARE_ACCOUNT_ID
```

### Bootstrap once (by hand — CI does none of this)

```sh
npx wrangler d1 create gw2         # then paste database_id into both wrangler.jsonc files
npx wrangler d1 migrations apply gw2 --remote
```

Plus, in the Cloudflare dashboard: a self-hosted **Access application** for `gw2.itguys.ro` with
the existing `Admin Access` policy attached. Do **not** hand-create the DNS record — wrangler
creates the proxied record itself from the `custom_domain` route on the first deploy, and the
binding fails if a record already exists.

### Reseed the definition caches (manual, after an expansion)

Recipe and item definitions live in D1 (`recipe_defs`, `item_defs`) and are read from there
instead of re-fetched — a warm cache costs ~6 GW2 API requests a run instead of ~96. The hourly
Worker keeps them honest by itself: it always fetches ids the cache has never seen, and re-reads
`RECIPE_REFRESH_PER_RUN` (600) of the oldest rows per run, turning the whole table over in about a
day. **New recipes therefore appear without any manual step.**

The seeder exists for the two cases that trickle handles badly — a cold/lost cache, and a content
patch that rewrites definitions the cache already holds (reworked recipes, renamed or restatted
items), where the ids are not new so only the staleness re-read would catch them, a day later.

```sh
bash scripts/seed-cache.sh              # resume: fetch only ids not already in .seed/
bash scripts/seed-cache.sh --refresh    # re-fetch EVERY definition — expansion / big patch
```

Runs `scripts/seed-cache.ts` straight from this working copy (local Bun; it is not part of either
Worker and is not deployed). It fetches into `.seed/*.jsonl`, emits `.seed/*.sql`, and the wrapper
applies those with `wrangler d1 execute --file`, then prints the resulting row counts. Nothing has
to be stopped while it fills — the seeder only writes cache tables the Worker already reads.

Takes 10-20 min cold and is safe to interrupt and re-run: pages are banked to disk as they land,
so a re-run continues instead of restarting.

## Notes

- **`data/coin-vendor.json`**: only confirmed coin-buyable mats are bundled; anything missing just
  falls back to TP pricing, which overprices the craft and hides real ROI. Add as confirmed.
- A thin board is a **velocity-gate artifact**, not a pricing bug.
- Peak memory tracks `item_defs` row count against a fixed 128 MB isolate ceiling (90.8 MiB
  measured 2026-08-31). Re-measure after a large expansion.
