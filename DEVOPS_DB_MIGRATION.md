# DevOps runbook — DB migrations for this release

**Audience:** whoever deploys the backend to the live server.
**TL;DR:** this release adds **7 new nullable columns + 1 index** across
4 Alembic migrations (`0015` → `0018`). Run `alembic upgrade head` on the
live database as part of the deploy. It is online-safe (no locks that
matter, no backfill, no downtime). If migrations are skipped, the new code
will 500 on multi-role / role-switch / ownership-transfer / per-role
Docket features.

> **Update (2026-09-11):** the first deploy attempt failed partway through
> with `DuplicateColumnError: column "department_id" of relation
> "user_roles" already exists` while running `0014 -> 0015`. That means
> `user_roles.department_id` (and possibly other 0015–0017 columns) was
> already present on live — from a prior partial/manual run — while
> `alembic_version` still said `0014`, so Alembic tried to re-add it.
> **Fix:** migrations `0015`, `0016`, and `0017` have been rewritten to use
> `ADD COLUMN IF NOT EXISTS` / `DROP COLUMN IF EXISTS` (matching the style
> `0018` already used), exactly like this file's §6 already documented for
> `0018`. Re-running `alembic upgrade head` with the updated code now
> succeeds regardless of which of the 0015–0017 columns already exist on
> live — it fills in only what's missing and safely no-ops on the rest.
> **Action needed:** pull the latest backend code (which includes the
> fixed migration files) before retrying the deploy.

---

## 1. Scope of DB change

| Rev | Table | Change | Type |
|-----|-------|--------|------|
| **0015** | `user_roles` | `+ department_id  UUID NULL  FK → departments.id` | add column |
| **0015** | `user_roles` | `+ establishment_id  UUID NULL  FK → establishments.id` | add column |
| **0016** | `users` | `+ account_predecessor_id  UUID NULL  FK → users.id` | add column |
| **0016** | `users` | `+ INDEX ix_users_account_predecessor_id (account_predecessor_id)` | create index |
| **0017** | `efms_files` | `+ creator_role  VARCHAR(50) NULL` | add column |
| **0017** | `efms_files` | `+ current_holder_role  VARCHAR(50) NULL` | add column |
| **0017** | `route_entries` | `+ from_role  VARCHAR(50) NULL` | add column |
| **0017** | `route_entries` | `+ to_role  VARCHAR(50) NULL` | add column |
| **0018** | `users` | `+ middle_name  VARCHAR(100) NULL` (`ADD COLUMN IF NOT EXISTS`) | add column |

- **No table drops, renames, type changes, NOT NULL additions, or data
  backfill.** Every added column is nullable with no default.
- `0018` is a drift fix — the ORM model has had `users.middle_name` for a
  long time with no migration. It uses `ADD COLUMN IF NOT EXISTS`, so it is
  a no-op on any DB where the column was already added manually.
- Postgres `ADD COLUMN ... NULL` with no default and `CREATE INDEX` (not
  `CONCURRENTLY`, but the tables are small) take a brief `ACCESS EXCLUSIVE`
  lock only for the catalog update — milliseconds. Safe during traffic; a
  maintenance window is **not** required.

## 2. Migration chain / current state

- Migrations live in `backend/alembic/versions/`.
- Chain: `... → 0014 → 0015 → 0016 → 0017 → 0018 (head)`.
- The live DB is expected to be at **`0014`** (project-number sequence) or
  possibly `0013`. Verify with `alembic current` (step 4).
- Alembic reads the DB URL from the app config
  (`backend/app/core/config.py` → `DATABASE_URL`, normally set in
  `backend/.env`). The `sqlalchemy.url` line in `alembic.ini` is **ignored**
  — `alembic/env.py` overrides it. So: make sure the deploy environment has
  the correct `DATABASE_URL` before running alembic.

## 3. Pre-flight

```bash
# from the backend/ directory of the deployed code, with the venv active
cd backend

# a) confirm the migration files arrived with this deploy
ls alembic/versions/001[5-8]_*.py
#   0015_user_role_context.py
#   0016_account_predecessor.py
#   0017_file_role_scoping.py
#   0018_add_user_middle_name.py

# b) confirm alembic can see the DB and where it is
alembic current            # expect: 0014 (or 0013)
alembic heads              # expect: 0018 (head)

# c) TAKE A DB BACKUP (standard pre-migration snapshot / pg_dump)
```

## 4. Apply

```bash
cd backend
alembic upgrade head
```

Expected output ends with:

```
INFO  [alembic.runtime.migration] Running upgrade 0014 -> 0015, ...
INFO  [alembic.runtime.migration] Running upgrade 0015 -> 0016, ...
INFO  [alembic.runtime.migration] Running upgrade 0016 -> 0017, ...
INFO  [alembic.runtime.migration] Running upgrade 0017 -> 0018, ...
```

Then restart / roll the backend service so the new code runs against the
migrated schema.

### Ordering vs. the app

- **Preferred:** migrate, then deploy new code.
- **Also safe:** deploy new code and migrate within the same window. The
  new code only *uses* these columns for the new features; until they
  exist those specific requests fail, but the migration is quick.
- **Not safe:** deploy new code and postpone the migration. Multi-role,
  role-switch, ownership-transfer, and file-forward-with-role will error
  until `alembic upgrade head` runs.

## 5. Verify (post-migration)

```bash
alembic current            # expect: 0018 (head)
```

```sql
-- columns present & nullable
SELECT table_name, column_name, is_nullable, data_type
FROM information_schema.columns
WHERE (table_name='user_roles'   AND column_name IN ('department_id','establishment_id'))
   OR (table_name='users'        AND column_name IN ('account_predecessor_id','middle_name'))
   OR (table_name='efms_files'   AND column_name IN ('creator_role','current_holder_role'))
   OR (table_name='route_entries' AND column_name IN ('from_role','to_role'))
ORDER BY table_name, column_name;
-- expect 8 rows, all is_nullable = YES

-- index present
SELECT indexname FROM pg_indexes
WHERE tablename='users' AND indexname='ix_users_account_predecessor_id';
-- expect 1 row
```

Smoke test in the app:
1. Log in (exercises `users.middle_name`) — should succeed.
2. Admin → User Management → Edit a user → "+ Add another role" → Save.
3. That user logs in → top-right menu shows a **Switch Role** section →
   switch → Dashboard reloads without error.

## 6. Rollback

Each migration has a working `downgrade()`.

```bash
cd backend
alembic downgrade 0014     # reverts 0015, 0016, 0017, 0018
```

- `0015/0016/0017` downgrades run `DROP COLUMN IF EXISTS` / `DROP INDEX IF
  EXISTS` (same idempotent style as `0018`, added after the first deploy
  attempt hit drift — see the update note at the top of this file) — the
  new columns hold only data written by the new code, so dropping them
  loses only that release's role metadata (files revert to "visible in
  every role", which is the pre-release behaviour).
- `0018` downgrade is `DROP COLUMN IF EXISTS middle_name` — **only run this
  if you are also reverting to code that predates `middle_name`.** If the
  ORM model still references it, keep `0018` applied and stop the rollback
  at `0015` instead: `alembic downgrade 0015` is not valid syntax; use
  `alembic downgrade 0017` to drop just 0018, or target the exact revision
  you need.
- After any downgrade, redeploy the matching (older) code.
- Do **not** downgrade past `0014`.

## 7. Notes

- `backend/seed.py` and `backend/uploads/` are intentionally gitignored —
  **do not** run `seed.py` on live. It creates dummy users/files and is for
  local dev only. This release needs no seed data.
- No environment variables were added or changed by this release.
- No new services, queues, or cron jobs.
