# Cloudflare migration plan

Supersedes the shape proposed in [issue #2](https://github.com/dustfeather/gw2roi/issues/2).
That issue kept the CronJob in k3s and reached D1 over the REST API. **This plan moves the whole
job to Cloudflare** — the k3s footprint goes to zero.

Decided 2026-08-31. Every limit and measurement below was verified, not assumed.

---

## 1. Why the shape changed

Issue #2 explicitly considered and dropped "moving the job itself to a Workers Cron Trigger".
Three measurements taken since reverse that call.

| gate | measured | limit | verdict |
|---|---|---|---|
| Cloudflare plan | **Workers Paid**, `plan_id=workers_paid`, billed since 2026-02-22 | Free caps CPU at 10 ms/invocation | passes; marginal cost **$0** |
| peak memory | **90.8 MiB** (cgroup `memory.peak`); 59.1 MiB anonymous high-water | 128 MB per isolate, all plans | passes, 1.4–2.2× headroom |
| wall clock | **13–25 s** warm; p50 61 s over 657 runs | 15 min per Cron Trigger invocation | passes, ~40× margin |
| subrequests | ~100 warm / ~140 cold | 10,000 per invocation (Paid) | passes |
| CPU time | `score_known` + `score_learnable` = **136–194 ms** | 15 min per cron invocation | passes |
| simultaneous connections | **1 in-flight** (`MIN_INTERVAL_MS = 210` serializes) | 6 awaiting response headers | non-issue |

Two corrections to issue #2 while we are here:

- Subrequests on Workers Paid are **10,000**, not 1000. The 1000 figure is D1-specific
  ("queries per Worker invocation").
- "Cost: Zero" was true only for the REST shape on a Free plan. The account is on Workers Paid
  already, so the $5/mo is sunk and this migration adds nothing.

### The one real risk

The 11–13 min runtime quoted in issue #2 is **historical**. It was the cold-def-cache regime,
ended by `f2c1d30`/`8bc7904`/`2f40a8d` (2026-08-11/12), which made `recipe_defs`/`item_defs`
actually persist. Reconstructed from `account_balance` (one row per run, 657 runs — it doubles
as a duration series):

- 2026-07-30 → 08-11: p50 200–320 s, **max 858 s**
- 2026-08-12 onward: p50 25–60 s, max 328 s
- last 10 on-schedule runs: 19–60 s

That 858 s maximum sat **42 seconds** under the 900 s pod deadline. The Worker's wall limit is
the same 900 s. **A cold def cache reproduces that regime.** Mitigation is structural, not
hopeful: §7 imports the def caches into D1 before the first Worker run, so the cold path is
never taken in production.

Related: peak memory scales with `item_defs` row count, which grows every game patch. 90.8 MiB
today, 128 MB ceiling. Re-measure after a large expansion.

---

## 2. Target architecture

```
Cloudflare Cron Trigger (0 * * * *)
        │
        ▼
  gw2-roi-cron  ── D1 binding ──▶  ┌───────────┐
  (scheduled() only, no route)     │  D1 "gw2" │
                                   └───────────┘
  gw2-roi-web   ── D1 binding ──▶        ▲
  (fetch() only, SSR)                    │
        │
   gw2.itguys.ro  ── behind Cloudflare Access
```

**Two Workers, not one.** The cron Worker has no route and no custom domain, so it has zero
public surface by construction rather than by policy — it holds `ARENA_NET_KEY` and makes the
account-authenticated GW2 calls. A dashboard redeploy also cannot disturb the hourly job.
`scheduled()` is not an HTTP request and never passes through the Access edge, so Access never
interferes with the cron either way.

D1 bindings are not exclusive; two Workers binding one database is supported and normal.

---

## 3. Repo layout

Monorepo matching `dosar-rapid.ro`, which is the shape `deploy-cloudflare.yml` was built around.

```
apps/cron/          wrangler.jsonc, src/worker.ts     → scheduled() only
apps/web/           wrangler.jsonc, src/worker.tsx    → fetch() only, custom domain, assets
packages/core/      cost.ts roi.ts gw2api.ts datawars.ts config.ts schema.ts db.ts types.ts
data/               coin-vendor.json, free-mats.json   (bundled, 365 B + 514 B)
drizzle/            generated migrations
scripts/            seed-cache.ts (stays local Bun)
```

`packages/core` holds the actual value — the cost model and the gates. Both Workers import it:
cron to write, web to read and render.

### Runtime port

The codebase is **already 100% TypeScript** (`src/*.ts`, `scripts/*.ts`, `tsc --noEmit` gating CI
and the pre-commit hook). Nothing to port there.

The Bun audit found **zero `Bun.*` APIs**. The runtime port is four items:

| item | fix |
|---|---|
| `config.ts` builds `config` at module scope from `process.env`, throws on missing key | becomes `buildConfig(env)` called **inside** the handler — Workers deliver vars as the `env` argument; there is no `process.env` |
| `src/index.ts` is top-level `await` + try/catch/finally | becomes `scheduled(event, env, ctx)` |
| `process.exitCode = 1` | drop; throw instead — a thrown `scheduled()` marks the invocation failed |
| `scripts/seed-cache.ts` uses `process.argv` | stays local Bun, not deployed — no change |

`config.ts` is the only non-mechanical change: every module importing the `config` const must
take it as a parameter. Everything else (`setTimeout`, `Date.now()`, JSON imports) survives
untouched.

`tsconfig.json` currently sets `"types": ["bun-types", "node"]`. The two apps switch to
wrangler-generated worker types (`wrangler types`); `bun-types` is retained only for `scripts/`.

**`nodejs_compat` stays off** — a deliberate divergence from house style. Every sibling repo
enables it, but dosar-rapid and flotila need it for Next.js/opennext, and `invest` carries it
without a demonstrated need. Nothing here requires it once `process.env` is gone, and it costs
isolate startup against the hard 1 s limit. Drizzle's own D1 docs enable it in their template;
that is boilerplate — `drizzle-orm/d1` does not require it. Turn it on only if something
concrete breaks.

---

## 4. Data layer

**Drizzle ORM**, `drizzle-orm@0.45.2` + `drizzle-kit@0.31.x`, matching dosar-rapid and flotila.
`drizzle-orm/d1`. Schema declared once in `packages/core/schema.ts`; both Workers import it.
`craft_roi` row types stop being hand-maintained interfaces.

### Type mapping

| Postgres | D1 / SQLite | note |
|---|---|---|
| `bigint` (money, ids) | `INTEGER` | coin values and txn ids are well under 2^53 |
| `double precision` (`roi_pct`) | `REAL` | |
| `text` | `TEXT` | |
| `jsonb` (`def`) | `TEXT` | `JSON.parse` on read |
| `timestamptz` | `INTEGER` **epoch ms** | Drizzle `integer({ mode: 'timestamp_ms' })` |
| `TRUNCATE` | `DELETE FROM` | SQLite has no TRUNCATE |
| `ON CONFLICT (id) DO NOTHING` | identical | |
| `fmt_coin()` PL/pgSQL | TS function in `packages/core` | no stored functions in SQLite |

Epoch-ms over ISO text because the TP cumulative panel does real time arithmetic across
`tp_transactions` and `account_balance` with backfill CTEs, and `recipe_defs` refresh is an
oldest-first age sort. Both are cleaner on integers. Export converts with
`EXTRACT(EPOCH FROM col)*1000`. House practice varies here — dosar-rapid uses integer epoch,
flotila ISO text — so there is no convention to violate.

**Dropping `fmt_coin` also removes a bug class.** The Grafana panels do `fmt_coin(profit) AS
profit`, and PostgreSQL resolves a bare `ORDER BY profit` against the output alias first — a
silent lexicographic sort (`2g 3s 43c` above `2g 27s 17c`). Formatting at render means sorting
the raw `net_profit` integer; the trap cannot recur.

### Migrations

Replaces the inline-DDL-every-run model (DDL string literals in `db.ts`, executed at the start
of every hourly run, schema changes appended as `ALTER TABLE … IF NOT EXISTS`). That model keeps
no record of what has been applied — idempotency *is* the mechanism.

`drizzle-kit generate` emits numbered SQL from the TS schema into `drizzle/`; wrangler applies it:

```jsonc
"d1_databases": [{
  "binding": "DB",
  "database_name": "gw2",
  "database_id": "…",
  "migrations_dir": "drizzle"
}]
```

Applied from `pre-deploy-command`, i.e. **before** the new code goes live. Under inline DDL on a
Worker, the first cron invocation after a deploy would carry the DDL, so a schema failure would
surface as a failed *run* rather than a failed *deploy*.

`drizzle.config.ts` needs `CLOUDFLARE_D1_TOKEN` + account/database ids for the `d1-http` driver,
but only for local `drizzle-kit` runs. CI applies migrations through wrangler using the existing
`CLOUDFLARE_API_TOKEN` — no new CI secret.

### Reads

**`recipe_defs` / `item_defs` are read with a full-table scan** — `SELECT id, def FROM
recipe_defs`, two queries per run. The current `WHERE id = ANY($1)` in 5,000-id chunks is a
Postgres artifact: the pipeline already reads essentially the whole cache every run (13,183
recipes, 13,961 items), so the filter buys nothing, and SQLite has no array parameter. The
chunked alternative would be ~270 queries against D1's 100-bound-parameter cap.

Billing: 27k rows/run × 720 runs = **19M rows read/month** against 25B included.

### Writes

D1 caps **bound parameters at 100 per query**. `craft_roi` has 18 columns → **5 rows per
multi-row `INSERT`** (90 params). At `TOP_N=100` that is 20 statements submitted as one
`db.batch()`, which D1 runs as a single implicit transaction — the same pattern dosar-rapid uses
for atomic multi-statement writes. Replaces the current 200-row chunks. The inlined-values trick
issue #2 mentions is unnecessary at this scale.

Per-run writes ≈ 100 + 100 ROI rows + ~200 txns + 600 def refreshes ≈ **~720k rows/month**
against 50M included.

---

## 5. Dashboard

**Hono + JSX, server-rendered on `gw2-roi-web`.** SSR keeps the D1 binding server-side; no token
or query ever reaches the client. 200 rows, one hourly snapshot, no time filter — React would
buy nothing and cost a hydration pipeline. `invest` is the house precedent: a plain Hono Worker
on a custom domain, no framework.

**Same five panels as the Grafana board**, relaid out: stat row across the top, full-width TP
cumulative graph, then **CRAFTABLE NOW and LEARNABLE side by side in one row**.

The two-up row matters because of a real constraint: **`craft_roi` currently holds 3 rows and
`craft_roi_learnable` holds 1.** `TOP_N=100`, but the velocity gates cut hard, and a thin board
is a gate artifact rather than a bug. Stacking two three-row tables under a full-width graph
looks broken; side by side it looks deliberate, and still degrades sanely if a patch floods the
board.

`net_profit` stays the single rank key — top-N selection, both table sorts, and the headline
stat. Market-true `profit` is displayed per row but does not rank. ROI stays a gate and a
displayed figure, never a rank key.

**Styling:** Tailwind, GW2 UI idiom. Built with `@tailwindcss/cli` into a committed
`.css.txt` loaded as a Text module — the `invest` pattern, which suits a plain Hono Worker
(dosar-rapid and flotila get Tailwind via Next.js, which does not apply here).

Static assets ship through **Workers Static Assets** (`assets` binding): requests to them are
free and unlimited, they version with the deploy and roll back with it, and edge caching plus
ETags are handled. R2 is for large or user-supplied blobs; these are build outputs. Item icons
come from `render.guildwars2.com`, so we link rather than host them.

`data/coin-vendor.json` and `data/free-mats.json` stay **bundled**, not in R2 — 879 bytes total
of git-versioned constants the cost model reads every run. R2 would add a binding, two
subrequests per run, and a new failure mode, and would decouple them from deploy rollback.

---

## 6. Hostname, Access, CI/CD

### Access

`gw2.itguys.ro` is covered by **nothing** today, confirmed three ways: no wildcard app exists
(every app enumerates literal hostnames); no `gw2` record among the 42 on the zone; and the org
has `deny_unmatched_requests: false` with an empty exempted-zones list — so an unmatched
hostname is **served publicly**, not blocked.

This is a genuine exposure change. Today `grafana.itguys.ro` is `A 100.96.0.4` **unproxied** —
WARP-mesh only, no Access app, unreachable from the internet by network topology. On a Worker,
Access is the only control, and the board renders `account_balance` and the full
`tp_transactions` ledger.

**Objects to create — two, plus zero new policies:**

1. **Access application**, `type: self_hosted`, its own app (not a literal on `ITGuys Admin`):
   - `destinations`: `gw2.itguys.ro`
   - `session_duration`: `730h` (house default for browser apps)
   - `allowed_idps`: **`[]`** — all IdPs, so one-time PIN is offered
   - `auto_redirect_to_identity`: `false` (required when `allowed_idps` is empty)
   - policies attached, both existing and reusable:
     - `Admin Access` (`b7cfc7c3-…`, allow) — humans
     - `Service Token Access` (`eb56b673-…`, non_identity) — CI verification
2. **Worker Custom Domain** `gw2.itguys.ro` on `gw2-roi-web`.

Its own app rather than a literal on `ITGuys Admin` because attaching `Service Token Access` to
that app would grant the CI token `itguys.ro/admin`, `/api/admin` and `invest.itguys.ro` as
well. An extra app object costs nothing: **Access bills per seat, not per app** — a user
occupies one seat regardless of how many applications they reach. Headroom is 500 apps (5 in
use), 500 reusable policies (3), 50 service tokens (3).

**Trap:** the `google-apps` IdP is pinned to `apps_domain: "itguys.ro"`, so
`dustfeather@gmail.com` cannot authenticate through it. Any app setting
`allowed_idps: [google-apps]` is Workspace-only. Leaving it `[]` is what the two newest apps
(`dosar-rapid`, `Automation API`) already do.

**Rejected:** extending `Automation API` to serve `gw2.itguys.ro/health`. Its only policy is
`Service Token Access` (`non_identity`), so a plain `curl` is denied and the deploy gate still
fails. Making it pass would need a `Bypass` policy — and policies attach to an *application*,
not to individual destinations, so that would make `itguys.ro/api/automation/posts` publicly
reachable with no authentication. Per Cloudflare's docs, Bypass "disables any Access enforcement
… and requests are not logged", is evaluated **before** Allow and Block, and cannot be narrowed
by identity. No `/health` endpoint is built at all — §6 verifies the board root instead, which
exercises more.

### DNS

`routes = [{ pattern = "gw2.itguys.ro", custom_domain = true }]` in `apps/web/wrangler.jsonc` —
the same declaration `invest` uses. Wrangler creates the proxied record itself on first deploy.

**Do not hand-create the DNS record first** — the custom-domain binding fails if a record already
exists. This matches 4 of the 5 existing hostnames (`invest`, `flotila`, `itguys.ro`, `www`);
only `dosar-rapid` uses the hand-made `AAAA 100::` placeholder style, which Cloudflare's routes
doc now explicitly advises against.

The cron Worker gets no route and no DNS record.

### CI/CD

Two caller jobs against `dustfeather/shared-workflows/.github/workflows/deploy-cloudflare.yml@v4`.
Runner `arc-df-gw2roi`, `node-version: "26"` (the shared default), `install-dir: .`.

```yaml
deploy-cron:
  uses: dustfeather/shared-workflows/.github/workflows/deploy-cloudflare.yml@v4
  with:
    working-dir: apps/cron
    install-dir: .
    runner: arc-df-gw2roi
    pre-deploy-command: npx wrangler d1 migrations apply gw2 --remote
    max-gzip-kib: 600
    max-startup-ms: 400
    # no verify-url: the cron Worker has no HTTP route by design
  secrets:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    WORKER_SECRETS: |
      ARENA_NET_KEY=${{ secrets.ARENA_NET_KEY }}

deploy-web:
  needs: deploy-cron
  uses: dustfeather/shared-workflows/.github/workflows/deploy-cloudflare.yml@v4
  with:
    working-dir: apps/web
    install-dir: .
    runner: arc-df-gw2roi
    build-command: <tailwind cli build>
    max-gzip-kib: 900
    max-startup-ms: 400
    verify-url: https://gw2.itguys.ro/
  secrets:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

Migrations run once, in the cron job's `pre-deploy-command`; `deploy-web` is gated on it so the
board never deploys against an unmigrated schema.

Gates already provided by the shared workflow: bundle gzip size (pre-deploy `--dry-run`), startup
time (post-deploy — `wrangler` only reports it on real upload; catches `10021 Script startup
exceeded CPU time limit`), and a post-deploy `wrangler secret list` proving every runtime secret
landed.

**One change needed in `shared-workflows`:** the verify step is a bare `curl` with no header
support, so it cannot authenticate past Access. Add a `verify-headers` secret input. Then
`verify-url` points at the board root `/` with the existing `github-actions-automation` service
token (`8b5ba88b….access`, no expiry) — which renders the real page and runs the real D1
queries, closing the one gap the other gates leave open (wrong binding name, broken SQL, SSR
throw). Generally useful: any repo deploying behind Access hits it.

`ARENA_NET_KEY` stays a GitHub Actions Secret and is the single source of truth, shipped via
`WORKER_SECRETS`. `PG_PASSWORD` is deleted after cutover.

---

## 7. Cutover

Big-bang. k3s is left running and **stopped by hand** afterwards.

1. **Dump all four tables** from Postgres — `COPY … TO STDOUT CSV`, timestamps converted to
   epoch ms. Commit `tp_transactions` (1,886 rows / 248 kB) and `account_balance`
   (657 rows / 88 kB) to the repo: they are small and **irreplaceable**
   (`/v2/account/wallet` returns only the current balance, so `account_balance` is the only
   balance history that will ever exist). Keep the 25 MB def dumps out of git.
2. Create D1 database `gw2`; `drizzle-kit generate` the initial migration; apply it.
3. **Import all four tables** via `wrangler d1 execute --file` (5 GB import limit; the whole DB
   is 33 MB). Importing the def caches is what keeps the first Worker run off the 858 s path.
4. Create the Access app + attach both existing policies. Deploy both Workers.
5. Verify the board renders and the first cron invocation completes.
6. **Manual, by hand:** suspend the k3s CronJob, then delete `k8s/postgres.yaml`, its PVC,
   `k8s/grafana/*.yaml`, the `gw2-postgres-creds` secret, and the GHCR image.

Current sizes — whole DB **33 MB**:

| table | rows | size |
|---|---|---|
| `item_defs` | 13,961 | 15 MB |
| `recipe_defs` | 13,183 | 9.6 MB |
| `tp_transactions` | 1,886 | 248 kB |
| `account_balance` | 657 | 88 kB |
| `craft_roi` | 3 | 32 kB |
| `craft_roi_learnable` | 1 | 32 kB |

---

## 8. What gets deleted

| artifact | fate |
|---|---|
| `k8s/cronjob.yaml`, `configmap.yaml`, `postgres.yaml`, `rbac.yaml` | deleted |
| `k8s/grafana/**` | deleted |
| `Dockerfile`, GHCR image, `build.yml` | deleted — wrangler bundles |
| `scripts/run-now.sh`, `kick-init-job.sh`, `provision-grafana.sh` | deleted |
| `scripts/seed-cache.{ts,sh}` | kept, repointed at D1, stays local Bun |
| `pg`, `@types/pg` | dropped |
| `src/db.ts` inline DDL | replaced by Drizzle schema + migrations |
| `arc-df-gw2roi` scale set | kept — still runs the deploy |

`DESIGN.md` and the `(§n)` comments need updating for the changed pipeline semantics; `CLAUDE.md`
needs rewriting wholesale (its Commands, Architecture, Persistence, CI/CD and Grafana sections
all describe the k3s/Postgres shape).

---

## 9. Open items

- `shared-workflows`: add the `verify-headers` input (§6). Blocks `deploy-web` verification only.
- Re-measure peak memory after the next large game expansion — it tracks `item_defs` row count
  against a fixed 128 MB ceiling.
- Optional follow-up: the throttle serializes to **1 in-flight request**, using ~4.8 of the
  5 req/s GW2 budget. Raising concurrency toward 5 (still under the 6-connection cap) would cut
  the dominant cost of every run. Out of scope here; noted because the measurement made it visible.
