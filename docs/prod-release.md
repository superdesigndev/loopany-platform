# Production release runbook

How server-side changes reach **https://loopany.ai** (Fly app `loopany-prod`, region
`sjc`). Staging (`loopany-testing`, `fly.toml`) auto-deploys on every push to `main`;
**prod is manual on purpose** and this doc is the checklist for cutting one.

## Why prod is manual (the single-scheduler invariant)

The server runs an **in-process scheduler** (croner). Two live machines = two
schedulers = **double-fire** of every cron loop. So prod pins exactly one machine
(`fly.prod.toml`: `min_machines_running = 1`, `auto_stop_machines = false`) and the
deploy uses `--ha=false`. **Never scale prod past one machine, and never wire prod to
auto-deploy** — push-to-main is staging's job; `v*` tags are the daemon's npm publish.
Prod ships only via a deliberate `workflow_dispatch`.

## Pre-deploy checklist

1. **Staging is green.** The change already auto-deployed to `loopany-testing` on
   merge; confirm that run passed (its post-deploy smoke asserts the served SHA) and
   the app looks healthy at https://loopany-testing.fly.dev/api/health.
2. **Daemon compatibility (do not skip when removing legacy endpoints).** The server
   records every daemon's version on poll (`machines.daemonVersion`). Before shipping
   anything that **removes or changes a legacy alias endpoint** (`/api/machine/loop`,
   `/api/machine/log`, `/agent-api/loop`, or the `finalizeCli` superset), inspect the
   live fleet and confirm no machine is on a version the change would break:

   ```sql
   -- against the prod Supabase DB (read-only)
   -- last_seen is stored as an ISO text stamp, so cast it for the range compare.
   select daemon_version, count(*)
   from machines
   where last_seen::timestamptz > now() - interval '30 days'
   group by daemon_version
   order by count(*) desc;
   ```

   If old daemons are still active, hold the removal — see the daemon-upgrade-window
   notes in `packages/server/CLAUDE.md`.
3. **Migrations are forward-only and rollback-safe** — see the checklist below. A
   migration ships as part of the deploy (it runs on container boot); confirm it is
   backward-compatible with the *currently running* image before you promote.

## Deploy

Manual dispatch only:

- **GitHub UI:** Actions tab → **Deploy Prod (Fly)** → *Run workflow* on `main`.
- **CLI:** `gh workflow run deploy-prod.yml --ref main`
  (or `gh-axi run ...`).

The workflow, in order:

1. **Preflight** — fails loudly if `FLY_API_TOKEN_PROD` is empty (so a rotted/unset
   secret can never again reach flyctl as an empty string).
2. **Deploy** — `flyctl deploy --ha=false -c fly.prod.toml -a loopany-prod`, baking
   the pushed commit into the image via `--build-arg GIT_SHA` / `--build-arg BUILT_AT`.
   Migrations run on container boot (`scripts/prestart.mjs`, postgres-js migrator over
   `DIRECT_DATABASE_URL`); a bad migration fails the boot, so the new release is never
   promoted.
3. **Smoke** — curls `https://loopany.ai/api/health`, fails the run on non-2xx or when
   the returned `sha` != the pushed `github.sha`.

## Verify

`/api/health` exposes the deployed build:

```bash
curl -s https://loopany.ai/api/health
# {"ok":true,"sha":"<git sha>","builtAt":"<utc iso>"}
```

- `sha` is the commit prod is actually serving. Compare it to `git rev-parse
  origin/main` to see whether prod is behind main and by how much.
- `sha: "unknown"` means the image was built without the `GIT_SHA` build arg (local
  dev, or a deploy path that bypassed CI).

## Rollback

Prod migrations are **forward-only**: an image rollback restores the *code*, **not the
schema**. Roll the image back only when the previous image's code is compatible with
the current (already-migrated) schema — that's exactly what the migration checklist
below guarantees.

```bash
# 1. Find the release to roll back to.
fly releases -a loopany-prod
#    VERSION  STATUS    DESCRIPTION            DATE
#    v9       complete  Release ...            2m ago   <- bad
#    v8       complete  Release ...            3h ago   <- good target

# 2. Redeploy the prior image (keep the single-machine invariant).
fly image show -a loopany-prod                       # confirm current image ref
fly deploy -a loopany-prod --ha=false -c fly.prod.toml --image <registry.fly.io/loopany-prod:deployment-...>
#    the image ref for v8 comes from `fly releases --image` / `fly image show` on that release.

# 3. Verify the rollback took.
curl -s https://loopany.ai/api/health   # sha should be the older commit
```

If the bad release included a schema migration that the older code cannot run against,
**do not image-rollback** — roll *forward* with a corrective commit instead (a new
migration that restores compatibility), then deploy normally.

## Migration backward-compatibility checklist

Because deploy == migrate and migrations never roll back, **every migration must be safe
against the previous image's code** (so an image rollback, or the brief window where the
old container is still serving during a deploy, never sees an incompatible schema).
Before merging a migration, confirm:

- [ ] **Additive, not destructive.** Adding a nullable column / new table / new index is
      safe. Dropping or renaming a column, or narrowing a type, breaks the old image —
      split it across two releases (release 1 adds the new shape and dual-writes; release
      2, after the old image is gone, removes the old shape).
- [ ] **No NOT NULL without a default** on a column the old code doesn't populate.
- [ ] **Renames are two-step.** Add new + backfill + dual-write first; drop old later.
- [ ] **Enum value changes need no migration** (`text(col, { enum })` is TS-only, no DB
      CHECK) and can't break existing rows — but confirm the old code tolerates a new
      value it doesn't know.
- [ ] **The migration is idempotent-safe on boot** — it runs via `prestart.mjs` over
      `DIRECT_DATABASE_URL`; a failure sets a non-zero exit and blocks the promote (good),
      so make sure a partial apply can't wedge the schema.

If a migration can't be made backward-compatible, it is a two-release change: ship the
additive half first, let it bake, then ship the removal in a later prod deploy.
