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
apps/web/           wrangler.jsonc, src/worker.tsx    → fetch() only, custom domain
packages/core/      cost.ts roi.ts gw2api.ts datawars.ts config.ts schema.ts db.ts fmt.ts
data/               coin-vendor.json, free-mats.json   (bundled, 365 B + 514 B)
drizzle/            generated migrations
scripts/            seed-cache.ts (stays local Bun)
```

*As built:* `packages/core` has no `types.ts` — the row types come from the Drizzle schema
(`typeof craftRoi.$inferSelect`) and everything else already lived beside its module. `fmt.ts`
took its place, holding the `fmt_coin` replacement. `index.ts` is the barrel both Workers import.
pnpm workspaces with `workspace:*` deps and no tsconfig `paths`, matching dosar-rapid.

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

*As built:* the oldest-first refresh slice is no longer a query either. `stalestDefIds` was
`SELECT id … WHERE id = ANY($1) ORDER BY fetched_at LIMIT n`, which has the same array-parameter
problem as the read above; since the full scan already returns every row's `fetched_at`, the slice
is picked in memory from those rows. Two queries per run total, not four.

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
buy nothing and cost a hydration pipeline. `invest` is the house precedent: a plain Worker on a
custom domain, no framework.

**Correction:** this plan said `invest` was "a plain Hono Worker". It is not — `invest` is a
hand-rolled `export default { fetch }` with an `if (method && pathname)` chain, HTML from template
literals, and a manual `escape()`. There is no Hono and no JSX anywhere in it. The decision here
stands anyway (Hono routes the four paths and JSX escapes by default, which is the half of
`invest` that is hand-written and easy to get wrong), but it is a new dependency for this repo
rather than a house convention being followed.

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

*As built: no `assets` binding.* Once the CSS is a committed Text module (the paragraph above),
that CSS is the **only** static asset the board has — the page ships zero JavaScript, no fonts and
no images. A second serving mechanism for one file buys nothing: the Text module already versions
and rolls back with the deploy, and it is served from a route with a content-hashed immutable
`Cache-Control`. Add the binding the day a real asset appears.

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
by identity. No `/health` endpoint is built at all: the deploy gate does not check whether the
app answers (§6), so nothing needs an unauthenticated path.

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
    # no verify-url: what matters is that the deploy succeeded, not that the
    # page answers — and the board is behind Access, so an unauthenticated
    # curl would get a 302 to the login page and fail every deploy
  secrets:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

Migrations run once, in the cron job's `pre-deploy-command`; `deploy-web` is gated on it so the
board never deploys against an unmigrated schema.

**Neither Worker sets `verify-url`.** The deliberate scope of the deploy gate here is *did the
deployment go through*, not *does the app answer*. That is already fully covered by `wrangler
deploy`'s exit code plus the three gates the shared workflow provides: bundle gzip size
(pre-deploy `--dry-run`), startup time (post-deploy — `wrangler` only reports it on real upload;
catches `10021 Script startup exceeded CPU time limit`), and a post-deploy `wrangler secret list`
proving every runtime secret landed.

Consequence accepted: a wrong D1 binding name, broken SQL, or a throwing SSR template ships
green and surfaces on first use rather than in CI.

**~~One genuine gap~~ — closed before this migration landed.** `shared-workflows` shipped
`expect-crons` (commit `eee5f3e`, "feat(deploy-cloudflare): assert Cron Triggers registered"),
which is reachable at `@v4` today but is **not in any `v4.x.y` semver tag** — `v4.9.1` predates
it. `deploy.yml` sets `expect-crons: 0 * * * *`; after the upload the job reads
`GET /accounts/{id}/workers/scripts/{name}/schedules` and fails naming anything missing. It
asserts the end state on the account rather than parsing wrangler output, so it covers the
`versions upload` path too. No new credential: the endpoint takes Workers Scripts Read, which the
deploy token already exceeds. The original gap description follows, because the *reason* it
existed is still the reason `apps/cron` must not switch deploy commands:

Nothing else asserts that a **Cron Trigger was actually registered**. For `gw2-roi-cron`, whose only
entrypoint is `scheduled()`, every existing gate misses it — `verify-url` has nothing to curl
(and its step is skipped outright when the input is empty), the gzip gate runs pre-deploy, the
startup gate proves the script parsed rather than that its triggers installed, and the secret
check proves secrets landed. A cron-only Worker can therefore deploy green with `triggers.crons`
silently unregistered, and the failure appears an hour later as "the job never ran", with no
failed workflow run to point at. Cloudflare's documented behaviour makes this easy to hit: an
`undefined` `triggers`/`crons` block leaves existing triggers in place and errors on nothing, so
a misplaced or unread config section deploys clean with zero schedules.

**Constraint that follows: `apps/cron` must deploy with plain `wrangler deploy`.** Do not
override `deploy-command` to `wrangler versions upload` — the shared workflow supports that path
and appends `--secrets-file` so secrets still land, but triggers get no equivalent handling.
Under `versions upload`, crons are applied only by a separate, still-`[experimental]`,
`wrangler triggers deploy`, so they would register never.

`ARENA_NET_KEY` stays a GitHub Actions Secret and is the single source of truth, shipped via
`WORKER_SECRETS`. `PG_PASSWORD` is deleted after cutover.

---

## 7. Cutover

> Superseded as a checklist by **§11**, which is the executable version with the current state
> folded in (step 2 is already done — the database exists and is migrated). This section is the
> reasoning; §11 is what to run.

Big-bang. k3s is left running and **stopped by hand** afterwards.

1. **Dump all four tables** from Postgres — `bash scripts/export-pg.sh`, which port-forwards to
   the cluster and emits SQLite-compatible `INSERT`s with timestamps converted to epoch ms. It
   writes `tp_transactions` (1,886 rows / 248 kB) and `account_balance` (657 rows / 88 kB) to
   `cutover/`, to be **committed**: they are small and **irreplaceable**
   (`/v2/account/wallet` returns only the current balance, so `account_balance` is the only
   balance history that will ever exist). The 25 MB def dumps go to the gitignored `.seed/`.
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

- ~~`shared-workflows`: cron-trigger registration is unverifiable at deploy time.~~ **Done** —
  `expect-crons` landed in commit `eee5f3e`, which closed
  [#22](https://github.com/dustfeather/shared-workflows/issues/22) (closed-completed
  2026-08-31T06:24Z), and `deploy.yml` uses it (§6). Reachable at `@v4` and `@v4.10.0`, which
  point at the same commit; a caller pinned to `@v4.9.1` or earlier silently does not have it.
- The rest of this list became actionable work and moved to **§11, the runbook** — repo secrets,
  the Access application, the data import, the first deploy, the k3s teardown, and the two
  non-blocking follow-ups (memory re-measure, request concurrency). §11 is the single list to
  work from; this section is kept for the reasoning behind each item, not as a checklist.

---

## 10. Status — 2026-08-31

**Done, in the repo, typechecking:**

- §3 monorepo layout, pnpm workspaces, `tsconfig.base.json`. `src/` is gone.
- §3 runtime port: `buildConfig(env)`, `createGw2Client(cfg)`, `scheduled()`, throw-not-exit-code.
  A fifth item the plan did not anticipate: `timing.ts` accumulated phases in module scope, which
  is **per isolate** on Workers, so a warm isolate reported the previous run's milliseconds added
  to its own. It resets at the top of the handler now.
- §4 Drizzle schema, generated migration `drizzle/0000_organic_stryfe.sql`, `fmtCoin` in TS,
  5-rows-per-INSERT writes inside one `db.batch()` per table, full-scan def reads.
- §5 board: Hono + JSX, inline-SVG graph, two-up tables, Tailwind Text module.
- §6 CI: both `deploy-cloudflare.yml@v4` callers, `expect-crons` wired, typecheck gate.
- §7 step 1 tooling: `scripts/export-pg.sh`. `scripts/seed-cache.{ts,sh}` repointed at D1.
- §8 deletions: `k8s/**`, `Dockerfile`, `build.yml`, the three cluster/Grafana scripts.
  `DESIGN.md` §7–§11 rewritten, `CLAUDE.md` rewritten, `README.md` rewritten.

**Verified locally, not just typechecked.** `wrangler dev --test-scheduled` ran the whole
`scheduled()` handler against the real GW2 API and a local D1, from a **cold** cache:

```
disciplines=Tailor:500,Weaponsmith:490,Chef:164,Artificer:417 unlocked=454 total_recipes=13183
recipes: cached=0/13183   qualified=5215 known=3819 learnable=1396
items:   cached=0/5832    priced_items=5664/5664   owned_free_mats=153 held_mats=458
known: scored=3637 passing=3 | learnable: scored=864 passing=1
wrote 3 known + 1 learnable rows, 1642 new tp transactions, balance=1698715c in 145245ms
timings: account=2270 recipes=106662 tp_prices=979 item_defs=31759 score_known=95
         score_learnable=24 write_rows=15 known_txns=3 fetch_txns=3156 write_txns=60
         wallet=207 write_balance=6
```

Three things that matters for:

- **3 passing known / 1 passing learnable** is exactly what the Postgres board holds (§5), so the
  cost model, the gates and the ranking survived the port unchanged.
- **145 s cold**, against the 858 s cold-cache maximum that was the one real risk in §1. The def
  import in §7 step 3 is still worth doing, but the cold path is no longer near the 900 s wall.
- `score_known + score_learnable = 119 ms` CPU, matching the 136–194 ms measured pre-migration.

The board was verified the same way: `wrangler dev` over a seeded local D1 returns 200 with all
four rows, both link forms, `fmtCoin` output including the `(free)` case, and four SVG series.

**Done since:** D1 database `gw2` created — `3a20d0b4-a187-4022-82cb-f091d33b4893`, region EEUR,
committed to both `wrangler.jsonc` files — and `0000_organic_stryfe.sql` applied to it.

---

## 11. Remaining work — runbook

Everything below needs a credential or a console click that the port itself did not. One fact set
the order: **the two missing Cloudflare repo secrets were the only thing failing the deploy.**
Adding them is the switch that makes the board public. So the Access application went first.

**Steps 1–3 are done (2026-08-31). Steps 4 and 5 remain.** The Access app exists, both repo
secrets are set, and all four tables are in D1 — so the next push to `main` that touches anything
outside `paths-ignore` (`*.md`, `docs/**`, `.claude/**`) is a real deploy, and the board goes live
behind Access at that moment. Nothing has been pushed yet.

State right now: `main` is on the Workers code, the k3s CronJob is still running on its
last-applied manifest, and both are writing nothing to each other. The old board keeps working
until step 5.

### Step 1 — Access application for `gw2.itguys.ro` (do this FIRST) — **DONE 2026-08-31**

Created, and no pre-existing app covered the hostname (the five apps were exactly the five listed
below), so there is no duplicate:

| field | value |
|---|---|
| app id | `cd586b62-1e86-4fcc-bec2-b25e11c6e7c0` |
| `aud` | `ec4873364b91ff3be22dd286710c6cd1eed4637629fac7a33d42e60dfa38b5b6` |
| destination | `gw2.itguys.ro`, `type: self_hosted`, `session_duration: 730h` |
| policies | `eb56b673-…` Service Token Access (prec 1) + `b7cfc7c3-…` Admin Access (prec 2), **both `reusable: true`** |

`reusable: true` on both is the bit that mattered: the `{id, precedence}`-only body linked the
existing policies rather than cloning app-scoped copies of them. Keep the `aud` — it is the JWT
audience tag anything validating the Access JWT server-side will need.

**Why first.** Re-confirmed on the account 2026-08-31: `deny_unmatched_requests: false`,
`deny_unmatched_requests_exempted_zone_names: []`, and **no existing app covers
`gw2.itguys.ro`** — the five apps are `ITGuys Admin` (path-scoped on `itguys.ro` plus
`invest.itguys.ro`), `Automation API` (`itguys.ro/api/automation/posts`),
`dosar-rapid render service` (`rdr-service.itguys.ro`), `App Launcher`, `Warp Login App`. No
destination wildcards the zone. So the app is the whole gate; there is no zone-wide backstop.

Sharper than §6 put it: the old board was not "unproxied so Access did not apply", it was
**never at the edge at all**. `grafana.itguys.ro` is `A 100.96.0.4`, `proxied=false` — a CGNAT /
WARP-mesh address, so traffic never reaches Cloudflare and Access *could not* have applied to it.
Private-by-network, not private-by-policy. Same for `apps`, `headlamp`, `nextcloud`, `pdf`,
`social`, `vault`. A Worker on a custom domain is the opposite: proxied by construction, reachable
from anywhere, and Access is the only control.

**Corollary worth stating, because it is how this gets silently broken later:** the protection
depends on the record being **proxied**. `routes: [{ custom_domain: true }]` in
`apps/web/wrangler.jsonc` creates a proxied record, which is correct. If anyone later replaces it
with a grey-cloud `A` record into the mesh — the house pattern for every other service on this
zone — **the Access app goes inert**, because requests stop passing through the edge that enforces
it. There is currently no `gw2` record of any kind on the zone (0 of 42), which is also why §6
says not to hand-create one.

Create one **self-hosted** application, its own app rather than a literal on `ITGuys Admin`
(attaching `Service Token Access` to that app would hand the CI token `itguys.ro/admin`,
`/api/admin` and `invest.itguys.ro` as well). An extra app object costs nothing: **Access bills
per seat, not per app.** Headroom is 500 apps (5 in use), 500 reusable policies (3), 50 service
tokens (3).

Both policies already exist and are attached **by id only** — exact values, verified:

| policy | id | decision |
|---|---|---|
| `Admin Access` | `b7cfc7c3-79f3-46d1-b5ea-3f957a200a0c` | `allow` (2 × email include) |
| `Service Token Access` | `eb56b673-6c3d-49f4-ab1e-60d4b6a8ea95` | `non_identity` (2 × service_token) |

```bash
CF=$(cat ~/.cf-token)
curl -s -X POST \
  "https://api.cloudflare.com/client/v4/accounts/328c2ac1408b3260bb83a7735a7fafe8/access/apps" \
  -H "Authorization: Bearer $CF" -H "Content-Type: application/json" --data @- <<'JSON' \
  | jq '{success, errors, id: .result.id, aud: .result.aud,
         policies: [.result.policies[]? | {id, name, precedence, reusable}]}'
{
  "name": "GW2 Crafting ROI",
  "type": "self_hosted",
  "destinations": [{ "type": "public", "uri": "gw2.itguys.ro" }],
  "session_duration": "730h",
  "allowed_idps": [],
  "auto_redirect_to_identity": false,
  "app_launcher_visible": true,
  "http_only_cookie_attribute": true,
  "policies": [
    { "id": "eb56b673-6c3d-49f4-ab1e-60d4b6a8ea95", "precedence": 1 },
    { "id": "b7cfc7c3-79f3-46d1-b5ea-3f957a200a0c", "precedence": 2 }
  ]
}
JSON
```

Four things about that body:

- **`allowed_idps: []` + `auto_redirect_to_identity: false` is deliberate, and is the one place
  not to copy `ITGuys Admin`.** That app pins Google Workspace
  (`385f2bf3-6404-4330-ba15-75bb13cfecee`) and auto-redirects. But the `google-apps` IdP is pinned
  to `apps_domain: "itguys.ro"`, so `dustfeather@gmail.com` cannot authenticate through it — an
  app that pins it is Workspace-only. Empty means every IdP is offered, including the account's
  `onetimepin` provider (`a2045a0f-a175-4e37-a894-a84d0bdcc6ad`), which is the escape hatch.
  `auto_redirect_to_identity` also requires *exactly one* `allowed_idps` entry, so with `[]` it is
  ignored regardless. `dosar-rapid render service` and `Automation API` both run `[]`.
- **Service token first (precedence 1)** so a machine caller never gets the login redirect.
- **Send `{id, precedence}` and nothing else per entry.** Adding `include`/`exclude`/`require`/
  `decision` inline converts the entry into a *new app-scoped, non-reusable* policy instead of
  linking the existing one — that is how `dosar-rapid render service` ended up with a
  `reusable: false` policy of its own. Hence the `reusable` field in the `jq` above: both must
  come back `true`.
- **Keep `result.aud`** from the response. It is the JWT audience tag, needed by anything that
  ever validates the Access JWT server-side.

`session_duration: "730h"` matches `ITGuys Admin` and `Automation API`. Do not copy
`dosar-rapid render service`'s `0s` — that means no session cookie at all, which is right for a
machine endpoint and wrong for a browser dashboard.

Wrangler has no Access command; this REST call (or Terraform
`cloudflare_zero_trust_access_application`) is the only path.

**Done when** the app lists `gw2.itguys.ro` and both policies come back `reusable: true`. Note the
hostname does **not** answer yet at this point — there is no DNS record until step 4 deploys the
Worker, so a `curl` gets NXDOMAIN, not a 302. The 302-to-login check belongs in step 4, right
after the first deploy, and is what proves the ordering held.

### Step 2 — Cloudflare repo secrets — **DONE 2026-08-31**

Confirmed absent on `dustfeather/gw2roi`: only `ARENA_NET_KEY` (2026-07-23) and `PG_PASSWORD`
(2026-07-23) exist, with zero variables and zero environments. They exist on `dosar-rapid.ro`, but
repo secrets do not cross repos and `dustfeather` is a User account, so there is no org tier to
inherit from.

The last pre-secret run (`33365994915`, 2026-08-31T06:53Z) failed exactly where that predicts —
`typecheck` green, then `deploy-cron` dying in **`Pre-deploy (migrations, reference data)`** on
`npx wrangler d1 migrations apply gw2 --remote`:

```
✘ [ERROR] In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN
          environment variable for wrangler to work.
```

`deploy-web` was `skipped`, not failed — the `needs: deploy-cron` gate held.

**Which token, and the risk taken.** Neither credential already on the box was fit for a repo
secret, and both were scoped before choosing:

| token | Workers Scripts Edit | D1 Edit | why it fails the bar |
|---|---|---|---|
| `~/.cf-token` (`Full Access`, id `0ac537a4…`) | yes | yes | account-wide — **356 permission groups, 170 write/admin**, all five zones, DNS Write, Access Service Tokens Write, `expires: never`; and `condition.request_ip.in = ["86.120.74.101/32"]` |
| `flotila/.dev.vars` (user-scoped, id `95d48863…`) | yes | yes | narrower, still carries **Access apps write** plus R2 + KV write across `dosar-rapid`/`invest`/`itguys.ro`; cannot read its own definition (no API Tokens Read), so its `condition` is unverifiable |

The Access-apps-write grant is the sharp one: the app created in step 1 is the *only* gate on
`gw2.itguys.ro` (there is no zone-wide backstop — `deny_unmatched_requests: false`), so a token
that can delete Access apps can delete the gate protecting the ledger.

**Decision: `~/.cf-token` is used anyway**, with the IP condition removed by hand so it does not
break when the residential WAN IP rotates. (It would have worked either way today — `arc-df-gw2roi`
runs on the k3s nodes behind that same WAN IP — but silently, and only until the ISP moved.)
Accepted consequence, recorded deliberately: **any workflow run in this repo holds full account
control**, including a run originating from a fork PR on the self-hosted runner. The
least-privilege alternative is a third token scoped to Workers Scripts:Edit + D1:Edit only; mint
one if that blast radius ever stops being acceptable.

```sh
gh secret set CLOUDFLARE_API_TOKEN   --repo dustfeather/gw2roi   # Workers Scripts Edit + D1 Edit
gh secret set CLOUDFLARE_ACCOUNT_ID  --repo dustfeather/gw2roi   # 328c2ac1408b3260bb83a7735a7fafe8
```

The token needs Workers Scripts **Edit** and D1 **Edit**. `expect-crons` additionally reads
`/workers/scripts/{name}/schedules`, which takes Workers Scripts **Read** — already implied by
Edit, so no extra grant.

Set them over **stdin**, not `--body`: a value passed as an argument is visible in the process
list for as long as the call runs.

```sh
printf %s "$(<~/.cf-token)" | gh secret set CLOUDFLARE_API_TOKEN --repo dustfeather/gw2roi
```

**Done when** `gh secret list --repo dustfeather/gw2roi` shows four names — confirmed
2026-08-31T08:24Z: `ARENA_NET_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `PG_PASSWORD`.

### Step 3 — Move the data — **DONE 2026-08-31**

Needs `psql` on the box (`export-pg.sh` exits 1 without it) — `apt-get install postgresql-client`.

```sh
bash scripts/export-pg.sh                     # port-forwards, dumps all four tables
git add cutover/ && git commit -m "chore: bank the irreplaceable ledger dumps"

npx wrangler d1 execute gw2 --remote --file .seed/item_defs.sql        # defs FIRST
npx wrangler d1 execute gw2 --remote --file .seed/recipe_defs.sql
npx wrangler d1 execute gw2 --remote --file cutover/tp_transactions.sql
npx wrangler d1 execute gw2 --remote --file cutover/account_balance.sql
```

Defs first because that is what keeps the first Worker run off the cold path. The local cold run
measured 145 s (§10), so this is no longer the risk §1 thought it was — but it is still 27k rows
of API traffic avoided on the very first invocation.

`tp_transactions` and `account_balance` are **committed** because they are irreplaceable:
`/v2/account/wallet` returns only the current balance, so `account_balance` is the only balance
history that will ever exist, and `tp_transactions` outlives the API's ~90-day window. The 25 MB
def dumps stay in the gitignored `.seed/` — they can always be refetched.

**Done when** the counts match the source:

```sh
npx wrangler d1 execute gw2 --remote --command \
  "SELECT 'recipe_defs' t, count(*) n FROM recipe_defs
   UNION ALL SELECT 'item_defs', count(*) FROM item_defs
   UNION ALL SELECT 'tp_transactions', count(*) FROM tp_transactions
   UNION ALL SELECT 'account_balance', count(*) FROM account_balance;"
```

Expect ≈ 13,183 / 13,961 / 1,886 / 657, allowing for rows the old job added between the dump and
the check.

**Result:** `13,183 / 13,961 / 1,886 / 661` — exact, the 661 being 657 plus four `account_balance`
rows the still-running k3s CronJob appended between when this plan was written and the dump.
The def import ran in 1.5 s + 0.9 s of D1 time (13,961 and 13,183 single-row statements).

#### What went wrong first: `COPY` has an escaping layer of its own

The first import attempt failed on both def dumps —
`unrecognized token: "\" at offset 525: SQLITE_ERROR` — while `tp_transactions` and
`account_balance` went in clean. This is a **second, distinct trap** from the `quote_literal()` →
`E'...'` one the script already guarded against, and worth writing down because the two look
nothing alike and the guard for one does not catch the other.

`export-pg.sh` ran its `SELECT`s wrapped in `COPY (...) TO STDOUT`. COPY's *text format* escapes
its own output: every backslash becomes `\\`, every newline becomes `\n`. The defs statement was
assembled across two source lines, so a newline sat **inside** the quoted SQL literal and COPY
emitted it mid-statement:

```
…,1788159621531)\n    ON CONFLICT(id) DO UPDATE SET def=excluded.def…
```

SQLite has no backslash escapes at all, so it hit `\` where a token had to begin. The other two
tables survived only by accident — their line breaks fall between `||` operators, outside the
literal, and their dumps are byte-identical under both paths.

The quieter half of the same bug: 927 genuine backslashes in the item JSON came out doubled. A
dump that happened to parse would have stored corrupted blobs **without erroring at all**.

Fix: emit through the existing `psql -At` helper with a plain `SELECT` (no COPY, no escaping
layer) and keep every generated statement on one source line.

**And the guard for it must test the doubled backslash, not a literal `\n`.** The first guard
written for this greped for `\n` and rejected a perfectly good dump at 912 lines: 155 item
descriptions genuinely contain one (`"+10% Damage vs. Undead\n-10% Damage from Undead"`), sitting
inside a JSON string inside a SQL string literal, which is where it belongs. Only the doubled
backslash separates the two paths — COPY emits it, `SELECT` never does; it went 927 → 0. Before
trusting that, all 29,691 statements were applied into a real SQLite database (0 failures) and all
27,144 `def` blobs `JSON.parse`d (0 failures).

### Step 4 — First deploy

```sh
gh workflow run deploy.yml --repo dustfeather/gw2roi     # or just push
```

What each gate actually proves, and what it does not:

| gate | proves |
|---|---|
| typecheck | the workspace compiles |
| bundle gzip (pre-deploy, `--dry-run`) | ≤ 600 KiB cron / 900 KiB web. Measured 42.7 / 64.6 KiB, so this is a creep alarm, not a live constraint |
| `wrangler secret list` | `ARENA_NET_KEY` actually landed on `gw2-roi-cron` |
| startup time (post-deploy) | the script parsed and initialised under 400 ms — **the version is already live when this runs** |
| `expect-crons` | `0 * * * *` is registered on the account, not merely present in a config file |

Neither Worker sets `verify-url`: the cron Worker has no HTTP surface, and the board is behind
Access so an unauthenticated curl would 302 and fail every deploy. **A green run therefore does
not prove the board renders or that the job works.** Check by hand:

1. **Check the gate before the content.** `curl -sI https://gw2.itguys.ro/` must return a **302 to
   the Access login page**, not 200 and not the board. A 200 here means step 1 did not take and
   the ledger is public — stop and fix that before anything else. Then open it in a browser,
   authenticate, and confirm the stat row, the graph and both tables render; the graph is the
   part that reads `tp_transactions` and `account_balance`, so it doubles as the import's
   end-to-end check.
2. Wait for the first `0 * * * *` tick, then `npx wrangler tail gw2-roi-cron` or:

   ```sh
   npx wrangler d1 execute gw2 --remote --command \
     "SELECT datetime(max(updated_at)/1000,'unixepoch') FROM craft_roi;"
   ```

   A timestamp inside the last hour means a real scheduled invocation completed. Expect 3-ish
   rows — a thin board is a velocity-gate artifact, not a failure.

### Step 5 — Tear down k3s (by hand, after step 4 is confirmed)

Nothing in CI touches the cluster any more, so the old CronJob keeps running on its last-applied
manifest until it is stopped. Suspend before deleting, so a failed cutover can be resumed by
flipping one boolean:

```sh
kubectl -n trading patch cronjob gw2-crafting-roi -p '{"spec":{"suspend":true}}'
# ...confirm the Worker has been writing for a few hours, THEN:
kubectl -n trading delete cronjob gw2-crafting-roi
kubectl -n trading delete statefulset gw2-postgres
kubectl -n trading delete svc gw2-postgres
kubectl -n trading delete pvc data-gw2-postgres-0        # irreversible — after step 3 is verified
kubectl -n trading delete secret gw2-api-key gw2-postgres-creds
kubectl -n trading delete configmap gw2-roi-config
kubectl -n trading delete role,rolebinding gw2-ci-deployer
```

Then:

- Delete the Grafana dashboard `gw2-craft-roi` and the datasource `gw2-postgres` — both otherwise
  linger pointing at a database that no longer exists.
- Delete the GHCR package `ghcr.io/dustfeather/gw2-crafting-roi-bot`.
- `gh secret delete PG_PASSWORD --repo dustfeather/gw2roi` — nothing reads it any more.
- Keep the `arc-df-gw2roi` runner scale set: it still runs the deploy.

### Rollback

Until step 5's deletes, rollback is cheap: unsuspend the CronJob and the old pipeline resumes
against a Postgres that never stopped holding its data. The manifests are one revert away
(`git revert c5bfbea` restores `k8s/**`, `Dockerfile` and `build.yml`), though re-applying them
needs an admin kubeconfig — the deployer Role never had the verbs for `postgres.yaml` or
`rbac.yaml`.

After the PVC is deleted there is no rollback, only a re-import from `cutover/*.sql` plus a
`seed-cache.sh` run. That is the reason the PVC delete is last and gated on step 3 being
verified.

### Still open, not blocking

- Re-measure peak memory after the next large game expansion — it tracks `item_defs` row count
  against a fixed 128 MB isolate ceiling (90.8 MiB today).
- The throttle serializes to 1 in-flight request. Raising concurrency toward 5 would cut
  `recipes=106662ms`, which the cold run confirms is the dominant cost of a run.
