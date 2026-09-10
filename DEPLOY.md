# Deploying this batch to the live server

This working tree has a set of new features whose backend code **reads and
writes database columns that do not exist on the live server yet**. If the
code ships without its migrations, the live server will 500 (or silently
no-op) on: multi-role users, role switching, ownership transfer, per-role
Docket/My Files, and anything that stamps a file with a role.

**Golden rule: the code and its migrations ship together, and
`alembic upgrade head` runs on live before (or atomically with) the new
code going live.**

---

## 1. What must be committed

These migration files are currently **untracked** in git (`git status` shows
them as `??`). A `git push` will NOT include them unless you `git add` them:

```
backend/alembic/versions/0015_user_role_context.py      # user_roles: department_id, establishment_id
backend/alembic/versions/0016_account_predecessor.py    # users: account_predecessor_id (+ index)
backend/alembic/versions/0017_file_role_scoping.py      # efms_files: creator_role, current_holder_role
                                                        # route_entries: from_role, to_role
backend/alembic/versions/0018_add_user_middle_name.py   # users: middle_name  (drift fix, IF NOT EXISTS)
```

Commit them in the SAME commit (or PR) as the backend code changes so they
can never get separated.

```
git add backend/alembic/versions/0015_*.py \
        backend/alembic/versions/0016_*.py \
        backend/alembic/versions/0017_*.py \
        backend/alembic/versions/0018_*.py
git add <the modified backend + frontend files>
git commit -m "feat: multi-role users, ownership transfer, per-role file queues"
git push
```

## 2. On the live server, after pulling the code — BEFORE serving it

```
cd backend
alembic current          # see where live is (should be 0014, maybe 0013)
alembic upgrade head      # applies 0015 -> 0016 -> 0017 -> 0018
alembic current          # confirm: 0018 (head)
```

Then restart / redeploy the backend so the new code runs against the
now-migrated schema.

## 3. Why this is zero-downtime and needs no backfill

Every column these migrations add is **nullable** and every query that
uses them treats `NULL` as "applies to all / any role":

| Migration | Columns | NULL means |
|---|---|---|
| 0015 | `user_roles.department_id`, `.establishment_id` | use the user's own dept/establishment for this role |
| 0016 | `users.account_predecessor_id` | not a successor account — normal user |
| 0017 | `efms_files.creator_role`, `.current_holder_role` | legacy file — visible in every role's workspace |
| 0017 | `route_entries.from_role`, `.to_role` | legacy hop — no role recorded |
| 0018 | `users.middle_name` | no middle name |

So **existing rows on live keep behaving exactly as before**. Only files
created / forwarded AFTER the deploy get a role stamp. No data rewrite, no
lock-heavy `ALTER`, safe to run while the app is up (though restarting the
app afterwards is still cleaner).

`0018` uses `ADD COLUMN IF NOT EXISTS` — harmless if the column was already
added by a manual `ALTER` on some environment.

## 4. Rollback

Each migration has a working `downgrade()`. If you must revert:

```
alembic downgrade 0014      # drops 0015-0018 columns
```

Then deploy the previous code. (Don't downgrade past `0014` unless you also
revert to code that predates project profiles.)

## 5. Seed data

`backend/seed.py` and `backend/uploads/` are gitignored on purpose — the
live server has its own real users and files. Nothing in this batch needs
seed data. The only manual data step, if any, is your own choice about
whether specific live users should be given extra roles via
**Admin → User Management → Edit → "+ Add another role"** once the code is
live.
