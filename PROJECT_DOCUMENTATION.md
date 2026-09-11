# AVFU eFMS — Project Documentation

**Audience:** any engineer picking up this codebase for the first time.
**Goal:** understand the domain, the data model, how a file moves through
the system, where every feature lives, and how to safely extend it.

This is a living document — when you add a table, an endpoint, or change a
workflow rule, update the relevant section here in the same PR.

---

## 1. What this system is

AVFU eFMS (Electronic File Management System) is a university file-routing
and notesheet system, modelled on a physical government "file" workflow:

- Someone **creates a file** (a subject + an official notesheet).
- They **forward** it to a colleague, who reads it, may add their own note,
  and forwards it onward — a chain of custody, exactly like a physical file
  moving desk to desk.
- Eventually someone **releases** it (makes it visible department-wide) or
  **dispatches** it (sends it outside the university via post/email/courier).
- Every movement, every note, and every attachment is permanently
  attributable to who wrote/added it and when.

It is a **monorepo**: FastAPI backend + Next.js frontend, one Postgres
database, no separate microservices.

```
eFMS-main/
├── backend/     FastAPI (Python 3.11), SQLAlchemy async, Alembic, asyncpg
├── frontend/    Next.js 16 (App Router, Turbopack), React 19, TypeScript
├── DEPLOY.md                    deploy notes for this repo's maintainer
├── DEVOPS_DB_MIGRATION.md       DB migration runbook for ops
└── PROJECT_DOCUMENTATION.md     this file
```

---

## 2. Tech stack

### Backend
| Layer | Choice |
|---|---|
| Framework | FastAPI |
| ORM | SQLAlchemy 2.x, **async** (asyncpg driver) |
| Migrations | Alembic — `backend/alembic/versions/0001` … `0018` (see §5) |
| Auth | JWT (access + refresh), 2-step email-OTP login |
| PDF rendering | Playwright headless Chromium (`app/utils/html_pdf.py`), with a LibreOffice fallback for environments without Chromium |
| Logging | `structlog`, JSON lines |
| Python | 3.11, venv at `backend/.venv` |

### Frontend
| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack), React 19 |
| Language | TypeScript |
| Styling | Tailwind CSS v4 (`@import "tailwindcss"`, uses `oklch()` colours) |
| State (server) | TanStack Query |
| State (client) | Zustand (`stores/auth.store.ts`, persisted to `localStorage` under key `efms-auth`) |
| Rich text | TipTap (`@tiptap/*`) — the notesheet editor |
| PDF (client-side) | `html2canvas-pro` + `jspdf` (timeline download) |
| HTTP | axios (`services/api.ts`), with automatic 401 → refresh-token retry |
| Icons / motion / toasts | lucide-react, framer-motion, sonner |

### Local dev
```bash
# Backend
cd backend
.venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8001

# Frontend
cd frontend
npm install
npm run dev         
```

`backend/.env` holds `DATABASE_URL`, `SECRET_KEY`, SMTP creds,
etc. — see `app/core/config.py` for every field and its default.
`backend/seed.py` creates the 15 `@avfu.ac.in` dummy accounts
(password `Admin@123`) for local testing — **never run it against a real
environment.**

---

## 3. Domain model — the vocabulary

Read this section before touching any workflow code; the naming is
deliberate and consistent throughout the codebase and this doc.

| Term | Meaning |
|---|---|
| **File** (`EfmsFile`) | The unit of work — one `ref_number`, one subject, one lifecycle. |
| **Notesheet** (`Notesheet`) | The file's original, creator-authored document. One per file, immutable once the file leaves Draft. |
| **Holder** | Whoever currently has the file (`current_holder_id`). Exactly one at a time, or `NULL` once released. |
| **Holding period** (`HolderNote`) | Each time someone holds the file, they get their OWN note row, separate from the creator's Notesheet and separate from any previous time they held it. |
| **Route entry** (`RouteEntry`) | One row per **Forward** or **Dispatch** action — the audit trail / timeline. |
| **Docket** | Two meanings — don't confuse them: (a) `Docket` the **table**, which only exists once a file is *released*; (b) "the Docket" the **UI screen**, which shows files *currently forwarded to you* (unrelated to the table until release). |
| **Release** | The creator makes a file visible to their whole department and nobody holds it anymore (`current_holder_id = NULL`). Creates/updates a `Docket` row. |
| **Reopen** | Only the creator, only on a released file: un-releases it and it comes back to the creator as an active file, with full history intact. |
| **Dispatch** | A file leaves the university (post/email/courier) — a distinct terminal path from Forward, tracked by `DispatchRecord`. |
| **PI profile** (project profile) | A synthetic `users` row representing one person acting *as* a specific project's Principal Investigator. See §6.3. |
| **Multi-role / role switching** | One physical person can hold several roles (e.g. eFMS Officer AND Registrar) and switch which one is "active" — each role has its own Docket/My Files workspace. See §6.4. |
| **Ownership transfer** | Super-admin action: when a person leaves, hand everything they hold/created to a successor and deactivate them. See §6.5. |
| **Tracking History** | A read-only, broader view: every file you've EVER touched (created, held, or were a routing participant in), regardless of whether you still hold it. |

---

## 4. Database — every table

All tables use a UUID primary key (`UUIDMixin`) and (mostly) `created_at`/
`updated_at` (`TimestampMixin`) — see `backend/app/db/base.py`.

### 4.1 Identity & access

#### `users`
The single table for **every** kind of identity: a real person, a PI
project-profile, or (after a transfer) a deactivated predecessor. This
dual/triple use is deliberate — see §6.3 and §6.5 for why.

| Column | Notes |
|---|---|
| `email`, `hashed_password` | `hashed_password` is `NULL` for a PI profile (can never log in directly — see §6.3) |
| `is_active` | The only column auth checks for "can this identity act" |
| `first_name`, `middle_name`, `last_name` | `full_name` is a **computed property**, not a column |
| `active_role` | Plain `VARCHAR`, not a Postgres enum — validated against the `roles` table at the application layer. This is "which role is this session acting as right now" |
| `can_sign` | E-signature permission (per user) |
| `establishment_id`, `department_id` | FK → `establishments` / `departments` — the person's own org context |
| `origin_user_id`, `project_id` | Both `NULL` for a normal person. Both **set** together (CHECK constraint) for a PI profile — see §6.3 |
| `account_predecessor_id` | Set on a successor after an ownership transfer — see §6.5 |
| `deactivation_reason_type`, `deactivation_remarks`, `deactivated_at`, `deactivated_by` | Audit trail for why an account was turned off |

#### `user_roles`
Every role a `users` row currently holds. A single-role user has one row
here matching `active_role`. A multi-role user has several.

| Column | Notes |
|---|---|
| `user_id`, `role` | `UNIQUE(user_id, role)` — `uq_user_role` |
| `department_id`, `establishment_id` | **Optional per-role context.** `NULL` = "use the user's own". Lets one person be Registrar in one office and HoD in another. |

#### `roles`
The super-admin-manageable role catalog (Role Management screen). This is
metadata only — it does **not** gate authorization. The one exception:
`is_system=True` is set on exactly the `super_admin` row, and the
privilege check is `User.active_role == SystemRole.SUPER_ADMIN` — never
anything read from this table.

#### `refresh_tokens`
One row per issued refresh token (`token_hash`, SHA-256). `revoked` flag.
Login, `switch-profile`, `switch-role`, and ownership-transfer all mint a
fresh pair via `_issue_tokens()`.

#### `favorite_recipients`
A user's personal shortlist of people they forward to often. Purely a UX
convenience — `UNIQUE(user_id, recipient_id)`.

#### `otps`
Email/mobile OTP codes for the 2-step login and forgot-password flows.
`target`, `code`, `is_used`, `expires_at`.

### 4.2 Organization

#### `establishments`, `departments`
Simple lookup tables (Office / Section in the UI). `departments.establishment_id`
optionally scopes a department under an establishment.
`departments.head_of_department_id` → `users.id` (informational).

### 4.3 Projects

#### `projects`
| Column | Notes |
|---|---|
| `project_number` | Auto-generated via a dedicated Postgres sequence (`project_number_seq`, migration 0014) — never a `count()+1` read, so concurrent creates can't collide |
| `status` | `active` \| `completed` |
| `current_profile_id` | FK → `users.id` — whichever PI-profile row currently represents this project |

### 4.4 eFMS files — the core workflow tables

#### `efms_files`
| Column | Notes |
|---|---|
| `ref_number` | e.g. `AVFU/GENX/2026/PRO/0004` — generated in `_generate_ref()` |
| `status` | `draft` → `active` → (`dispatched` is a separate terminal branch) — see §6.1 |
| `priority` | `normal` \| `urgent` \| `secret` (secret implies `is_confidential`) |
| `created_by` | Immutable — the file's creator, forever |
| `current_holder_id` | `NULL` once released; otherwise whoever holds it now |
| `creator_role`, `current_holder_role` | **Per-role workspace scoping** (multi-role users) — see §6.4. `NULL` = visible in every role (legacy files, or files from single-role users) |
| `recipient_id`, `recipient_name` | Informational only, set at Draft creation — the *intended* first recipient; the first real Forward is what actually moves the file |

#### `notesheets`
One row per file (`UNIQUE(file_id)`) — the creator's own document.
`content` is HTML from the TipTap editor. **Immutable once the file
leaves Draft** (enforced in `save_notesheet`). `is_locked=True` once
dispatched.

#### `notesheet_versions`
Snapshot history of `notesheets.content` on each save while still a Draft.

#### `holder_notes`
The **per-holding-period** note — the thing that makes this system
different from "just forward with a comment". See §6.2 for the full
mechanics. Key invariant: **at most one `is_current=True` row per file**,
enforced by a Postgres **partial unique index**
(`uq_holder_note_current_per_file`).

#### `route_entries`
The audit trail. One row per Forward or Dispatch action.
`from_role`/`to_role` (added in migration 0017) record which role sent/
received at that hop — `NULL` for pre-multi-role history.

#### `file_attachments`
Uploaded documents. `stored_name` is a UUID-based filename on disk
(`backend/uploads/`, gitignored); `original_name` is what the user sees.

#### `dispatch_records`
One row per file dispatched externally (`UNIQUE(file_id)`). Terminal —
once dispatched, the notesheet locks.

#### `dockets`
**Only exists for a released file.** `is_released`, `released_by`,
`released_at`. Reopening a file sets `is_released=False` on this same row
(never deletes it — that's how the system tells "never released" apart
from "released, then reopened", used by the "Reopened" badge in My Files).

#### `file_remarks`
Legacy/simple free-text remark table — largely superseded by
`route_entries.remarks` and `holder_notes`. Still present; check before
assuming it's dead code in any area you touch.

#### `file_signatures`
E-signature records — position on the PDF page, `pending`/`verified`
status, OTP-verified signing flow (`app/utils/signing.py`).

### 4.5 Admin lookups & notifications

#### `file_categories`, `file_priorities`, `file_recipients`
Super-admin-managed dropdown options for the New File form.

#### `notifications`
In-app notification feed (`is_read`, `file_id` FK with `ON DELETE SET NULL`).

#### `audit_logs`
Generic action log written by `app/middleware/audit.py` — `action`,
`resource_type`, `resource_id`, `details` (JSONB), `system` (`AMS` or
`eFMS` — this codebase is eFMS's half of a larger AVFU system).

### 4.6 Entity-relationship summary

```
users ──┬── user_roles (N roles, each optionally scoped to a dept/estb)
        ├── origin_user_id ──> users            (PI profile → the real person)
        ├── project_id      ──> projects
        ├── account_predecessor_id ──> users    (successor → predecessor)
        └── establishment_id / department_id ──> establishments / departments

projects ── current_profile_id ──> users (the active PI profile)

efms_files ──┬── created_by / current_holder_id ──> users
             ├── notesheets (1:1, creator's document)
             ├── holder_notes (1:N, one per holding period)
             ├── route_entries (1:N, the forward/dispatch trail)
             ├── file_attachments (1:N)
             ├── dispatch_records (0:1)
             └── dockets (0:1, only if ever released)
```

---

## 5. Migrations (Alembic)

Located at `backend/alembic/versions/`. Chain: `0001 → 0002 → … → 0018 (head)`.
Alembic reads the DB URL from `settings.DATABASE_URL` (i.e. `backend/.env`)
— **the `sqlalchemy.url` line in `alembic.ini` is overridden and ignored**
(see `alembic/env.py`).

| Rev | What it added |
|---|---|
| 0001 | Initial schema — every core table |
| 0002 | `can_sign` on users, `file_signatures` |
| 0003 | `notifications`, `file_categories`, `file_priorities`, `file_recipients`, `otps`, `dockets`, `file_remarks` |
| 0004 | `efms_files.recipient_id` / `recipient_name` |
| 0005 | Simplified workflow to Draft/Active/Released (dropped Approve/Reject/Return) |
| 0006 | `must_change_password` |
| 0007 | `favorite_recipients` |
| 0008 | `holder_notes` (first version) |
| 0009 | User deactivation metadata |
| 0010 | `roles` table (Role Management); widened `active_role`/`user_roles.role` from a fixed Postgres enum to `VARCHAR` |
| 0011 | Un-protect the legacy seeded roles (make them editable/deletable like any custom role) |
| 0012 | `holder_notes` gets holding-period semantics (`sequence`, `is_current`, the partial unique index) |
| 0013 | **Project profiles**: `projects` table, `users.origin_user_id`/`project_id` |
| 0014 | `project_number_seq` — atomic project-number generation |
| **0015** | **Multi-role context**: `user_roles.department_id` / `establishment_id` |
| **0016** | **Ownership transfer**: `users.account_predecessor_id` (+ index) |
| **0017** | **Per-role file queues**: `efms_files.creator_role`/`current_holder_role`, `route_entries.from_role`/`to_role` |
| **0018** | **Drift fix**: `users.middle_name` (the ORM model had it for a long time with no migration — `ADD COLUMN IF NOT EXISTS`, safe everywhere) |

**Every column added by 0015–0018 is nullable, no backfill, no downtime.**
See `DEVOPS_DB_MIGRATION.md` for the exact runbook to apply these on a
new/live environment.

**Rule going forward:** a schema change and the code that uses it ship in
the **same commit**. Never let a migration lag behind the code that reads
its columns — that's the exact failure mode that motivated writing that
runbook.

---

## 6. Core workflows — how a file actually moves

### 6.1 File lifecycle

```
                    ┌─────────┐
   create_file ───► │  draft  │ ◄── still editable by creator (30min→24h window)
                    └────┬────┘
                         │ first Forward (route_file, action=forward)
                         ▼
                    ┌─────────┐
                    │ active  │ ◄──────────────┐
                    └────┬────┘                │ reopen_file
                         │                      │ (creator only)
              ┌──────────┼───────────┐          │
              │ Forward  │ Release   │          │
              ▼          ▼           │          │
         (still active) released ────┴──────────┘
                         │
                         │ Dispatch (from any active state)
                         ▼
                    ┌────────────┐
                    │ dispatched │  (terminal — notesheet locks)
                    └────────────┘
```

- **Draft**: `current_holder_id == created_by`. Metadata + the shared
  `Notesheet.content` are editable by the creator only, only within
  `DRAFT_EDIT_WINDOW` (24 hours — `app/api/v1/endpoints/efms_files.py`).
  A file must have **real notesheet content** before it can be forwarded
  (`_is_notesheet_content_empty` check, enforced server-side, not just UI).
- **Active**: set on the first Forward and stays Active through every
  subsequent Forward. `current_holder_id` moves to whoever it was sent to.
- **Released**: creator-only action (`POST /docket/{id}/release`).
  `current_holder_id → NULL`, a `Docket` row is created/updated
  (`is_released=True`). The file becomes visible to the whole department.
- **Reopened**: creator-only (`POST /docket/{id}/reopen`), only on a
  released file. Sets `is_released=False`, `status=active`,
  `current_holder_id = creator`. **Reuses the same file record** — no new
  ref number, no new route entry, full history intact.
- **Dispatched**: a separate terminal action (`POST /efms/dispatch/{id}`)
  independent of Forward — for a file leaving the university.
  `notesheet.is_locked = True` once dispatched.

### 6.2 Notesheets vs. Holder Notes — the two-document model

This is the single most important, and most often misunderstood, piece of
the domain:

- **`Notesheet`** — ONE row per file. Written by the creator at Draft time.
  **Immutable** once the file leaves Draft (`save_notesheet` rejects edits
  after that). This is the file's permanent "cover note".
- **`HolderNote`** — one row **per holding period**. Every time a NEW
  person becomes the current holder (via Forward, or via Reopen), a fresh
  `HolderNote` row is created for them (`_start_holding_period`), and the
  outgoing holder's row is finalized (`_finalize_current_holder_note` /
  `_finalize_any_current_holder_note`) — flipped to `is_current=False`,
  permanently read-only from then on.
  - If the **same person** holds a file twice (A → B → A), the second
    holding gets its **own new row** — never overwrites the first.
  - `sequence` numbers the holding periods chronologically (2, 3, 4, … —
    `1` is reserved for the creator's Notesheet, which has no HolderNote
    row of its own).
  - `PATCH /efms/files/{id}/holder-notesheet` is how the current holder
    saves their own note — it does **not** forward, does **not** touch the
    shared Notesheet, does **not** touch anyone else's row.
  - A holder saving a note **before forwarding** just bumps
    `efms_files.updated_at` (sorts the file to the top of the Docket) and
    sets a `has_unsent_edits` flag on the Docket response (drives the
    "Draft saved" badge in the UI) — it does **not** change `status`.

### 6.3 Project (PI) profiles

A **project profile** is a real `users` row that represents "Person X,
acting as the PI of Project N". Why a whole extra `users` row instead of
a simpler "project membership" table? Because **every existing
authorization/ownership check in the codebase is keyed on `users.id`**
(`created_by`, `current_holder_id`, `RouteEntry.from_user_id/to_user_id`,
`HolderNote.user_id`, `FileAttachment.uploaded_by`, …). Making the PI
profile a genuine `users.id` means it is **indistinguishable from any
other user** to all of that code — zero special-casing needed anywhere
in the file workflow.

- `origin_user_id` points at the real person; `project_id` at the
  `Project`. Both set together, or both `NULL` (CHECK constraint).
- `hashed_password` is always `NULL` — a PI profile can never log in
  directly. It's reachable **only** via `POST /auth/switch-profile`, which
  verifies the caller's own `origin_user_id` matches before minting a
  fresh token pair for it.
- Created by `_create_project_profile()` (`app/api/v1/endpoints/projects.py`)
  on `POST /projects/{id}/assign` or `/reassign`. Copies the origin
  person's name (as `"<Full Name>" + "PI<n>"`), designation, mobile,
  department/establishment, and (since migration 0015/0017 work) their
  **entire `user_roles` set** — so a PI profile can switch roles exactly
  like the origin account (see §6.4).
- **Reassigning a project never deletes the old profile** — it's
  deactivated (`is_active=False`) and a brand-new profile row is created.
  This preserves every FK the old profile ever touched.
- Super admin can edit a PI profile's display fields (name, designation,
  mobile, department, establishment, role, can_sign) via
  `PATCH /projects/{id}/profile` — see `Edit PI` in Admin → Projects.

### 6.4 Multi-role users & per-role workspaces

A person can hold several roles (e.g. `efms_officer` AND `registrar`) via
`user_roles`. This is not just a label — **each role has its own separate
Docket and My Files**, exactly like switching between different project
profiles does.

**How it's stamped:**
- `create_file` sets `efms_files.creator_role = <creator's active_role>`.
- `route_file`'s Forward branch resolves the **recipient's target role**
  (the sender picks "Person — Role" in the recipient dropdown; see below)
  and stamps `route_entries.from_role`/`to_role` and
  `efms_files.current_holder_role`.
- `reopen_file` restamps `current_holder_role` to the creator's *current*
  active role.

**How it's queried (the scoping rule, applied everywhere a Docket/My Files
query runs):**
```sql
current_holder_role IS NULL  OR  current_holder_role = :active_role
```
`NULL` means "legacy file / single-role era — visible in every role". Only
files created or forwarded **after** migration 0017 carry a real stamp.

**The recipient picker:** `GET /admin/users` returns **one entry per role**
a multi-role user holds (`UserOut.role` field). The frontend option value
is `"<userId>::<role>"` (`splitRecipientValue()` in
`frontend/hooks/use-favorite-recipients.ts`); Forward sends both
`to_user_id` and `to_role`.

**Switching role:** `POST /auth/switch-role` — validates the requested
role against the caller's own `user_roles`, re-issues a fresh token pair
with the new `active_role` (and, if that role-row carries a
`department_id`/`establishment_id`, applies it to the session too). Works
both for a real person **and** for a PI profile (which inherits the full
role set from its origin).

**Known simplification:** `active_role` lives on the shared `users` row,
not per-session. Two browser tabs logged in as the same identity in two
different roles will fight over which one is "active" — acceptable for
now, flag if this becomes a real requirement.

### 6.5 Ownership transfer

Super-admin-only (`POST /auth/admin/users/{uid}/transfer-ownership`,
Admin → User Management → "Transfer ownership & retire"). For when someone
leaves a role/the organization and a successor takes over completely.

What it does, in order:
1. Every file the leaver **currently holds** (`current_holder_id ==
   leaver.id`) is re-pointed to the successor, with a `route_entries` row
   recording the hand-off ("Account ownership transferred: A → B") and
   `current_holder_role` set to the successor's active role.
2. `successor.account_predecessor_id = leaver.id` — this is the link that
   makes the successor **inherit read access to everything the leaver ever
   touched**, even files the leaver no longer holds. See
   `_identity_chain_ids()` in `efms_files.py`: it walks the
   `account_predecessor_id` chain and treats every id in that chain as
   "this person" for `_authorize_file_open` and `_assert_tracking_access`.
3. The leaver is deactivated (`is_active=False`, deactivation metadata
   set) and **all their refresh tokens are revoked** — their old session
   dies immediately.
4. History is **never rewritten** — old notes/route entries still name the
   leaver. The successor just gets *read* access to it via the chain.

This is NOT the same thing as reassigning a project's PI (§6.3) — that's
project-scoped; ownership transfer is account-wide.

---

## 7. Authorization model — who can see/do what

All of this lives in `app/api/v1/endpoints/efms_files.py` (the helpers
near the top of the file) and is reused by `docket.py` / `tracking.py`.
**Read the docstrings in the source** — they're intentionally thorough;
this section is the map, not a replacement.

| Function | Question it answers | Used by |
|---|---|---|
| `_has_full_file_access` | Can this user fully open the file right now? (admin, OR current holder, OR dept member on a file released to their dept) | `_assert_full_file_access`, `_authorize_file_open` |
| `_authorize_file_open` | Same, but returns `"full"` or `"creator_restricted"` (a narrow read-only view) instead of raising | `GET /efms/files/{id}` |
| `_assert_tracking_access` | Broader — was this user EVER a participant? (creator, current holder, past routing participant, or dept member on a released file) | Tracking History, `/track`, `/track/notesheet` |
| `_has_full_remark_visibility` | Sees every forward remark, or only their own? (admin or current holder → full) | `_visible_file`, `get_remarks` |
| `_has_full_tracking_visibility` | Same but ALSO true for the creator once the file is released | Tracking History's notesheet/remark rendering |
| `_identity_chain_ids` | The caller's own id **plus every predecessor** they inherited via ownership transfer (and, for a PI profile, resolves through `origin_user_id` first) | Wired into `_authorize_file_open` and `_assert_tracking_access` so a successor's access equals the union of everyone in their chain |

**Golden rule when adding a new file-scoped endpoint:** pick the
*narrowest* of these that satisfies the feature, don't invent a sixth
variant. If you genuinely need new semantics, extend one of these
functions (they're deliberately centralized) rather than duplicating the
department/current-holder/participant logic inline.

---

## 8. Backend — endpoint map

All routes are mounted under `/api/v1` (see `app/api/v1/router.py`).

### `app/api/v1/endpoints/auth.py` — `/auth/*`
Authentication, the user's own profile, Super-Admin user/role management.

| Method | Path | Notes |
|---|---|---|
| POST | `/login/step1` | email+password → sends OTP |
| POST | `/login/step2` | OTP → JWT pair |
| POST | `/change-password` | authenticated, own password only |
| POST | `/forgot-password`, `/forgot-password/verify`, `/forgot-password/reset` | unauthenticated OTP-based reset |
| POST | `/refresh` | rotate access token from refresh token |
| GET | `/my-profiles` | the caller's own account + every PI profile they hold |
| POST | `/switch-profile` | switch into a PI profile (or back) — §6.3 |
| POST | `/switch-role` | switch active role — §6.4 |
| POST | `/logout` | revoke the presented refresh token |
| GET | `/me` | current identity |
| GET/POST/PATCH/DELETE | `/admin/users*` | Super-Admin user CRUD, bulk CSV import/sample, status (activate/deactivate) |
| POST | `/admin/users/{uid}/transfer-ownership` | §6.5 |
| GET/POST/PATCH/DELETE | `/admin/roles*` | Role Management catalog |

### `app/api/v1/endpoints/efms_files.py` — `/efms/files/*` (+ `dispatch_router` at `/efms/dispatch`)
The workflow core. See §6 for the *why*; here's the *what*:

| Method | Path | Notes |
|---|---|---|
| GET | `` | List files — `?inbox=true` / `?outbox=true` / plain (created-or-held), all role-scoped |
| GET | `/search` | Full-text-ish search across accessible files |
| GET | `/{id}/track`, `/{id}/track/notesheet`, `/{id}/track/my-notes` | Tracking-eligible views (broader than full-open access) |
| GET/POST | `/{id}` / `` | Open a file / create one (Draft) |
| PATCH | `/{id}` | Edit Draft metadata (creator, within the edit window) |
| DELETE | `/{id}` | Delete a never-forwarded Draft (creator only) |
| PATCH | `/{id}/notesheet` | Edit the shared Notesheet (creator, Draft only) |
| GET/PATCH | `/{id}/holder-notesheet`, GET `/{id}/holder-notesheets` | The current holder's own note — §6.2 |
| GET | `/{id}/notesheet/download` | Full PDF (Chromium render) |
| **POST** | **`/{id}/route`** | **The Forward/Dispatch action** — the single place `status`, `current_holder_id`, holding periods, and role stamps all change |
| POST/DELETE/GET | `/{id}/attachments*` | Upload, delete (uploader, time-boxed), view/download/zip, DOCX preview |
| POST | `/{id}/sign`, `/{id}/sign/{sig_id}/verify` | OTP-verified e-signature |
| GET/POST | `/efms/dispatch` | List / create a dispatch record |

### `app/api/v1/endpoints/docket.py` — `/docket/*`
| Method | Path | Notes |
|---|---|---|
| GET | `` | **The Docket screen** — files forwarded TO me, role-scoped, excludes my own created files |
| POST | `/{id}/release` | Creator releases — §6.1 |
| POST | `/{id}/reopen` | Creator reopens — §6.1 |
| GET | `/released`, `/released/mine` | Department-wide vs. "my own released files" (feeds the Reopen picker) |
| GET | `/remarks/{id}` | Forward remarks, visibility-scoped |

### `app/api/v1/endpoints/tracking.py` — `/tracking/*`
| Method | Path | Notes |
|---|---|---|
| GET | `/history` | Every file the caller ever participated in — read-only, broader than Docket/My Files |

### `app/api/v1/endpoints/projects.py` — `/projects/*`
| Method | Path | Notes |
|---|---|---|
| POST/GET | `` | Create (optionally with an immediate `assign_user_id`) / list projects |
| POST | `/{id}/assign`, `/{id}/reassign` | PI profile creation — §6.3 |
| PATCH | `/{id}/complete`, `/{id}/reactivate` | Project status |
| GET/PATCH | `/{id}/profile` | Read/edit the current PI profile's display fields |

### `app/api/v1/endpoints/admin.py` — `/admin/*`
Super-Admin lookup-table CRUD (categories, priorities, recipients,
establishments, departments), the **recipient picker** (`GET
/admin/users` — role-expanded, see §6.4), favorites, notifications,
sign-permission grants.

---

## 9. Frontend — structure & conventions

### 9.1 Routing (`app/`, Next.js App Router)
```
app/(auth)/login, forgot-password          — public
app/(protected)/dashboard                  — main workspace (Docket / My Files / New File)
app/(protected)/files/[id]                 — the file page (notesheet-editor.tsx)
app/(protected)/search                     — cross-file search
app/(protected)/tracking                   — Tracking History
app/(protected)/admin                      — Super Admin panel (redirects here if role=admin/super_admin)
app/(protected)/account/change-password
```
`app/(protected)/files/page.tsx` **redirects to `/dashboard`** — there is
no standalone "all files" route; `files-list-page.tsx` exists but is not
currently mounted anywhere (check before assuming it's live).

`app/(protected)/layout.tsx` wraps every protected page in
`components/layouts/app-shell.tsx` (sidebar + topnav + auth guard).

### 9.2 Feature modules (`modules/`)
One folder per feature area; each exports the page-level component the
`app/` route renders:
- `dashboard/efms-dashboard.tsx` — Docket / My Files / New File tabs, all
  the search+sort tables, Release/Reopen actions.
- `files/notesheet-editor.tsx` — **the biggest file in the codebase.** The
  file page: notesheet history, "your notesheet" editor, Edit Draft
  (full-page), Forward panel, attachments, tracking/timeline modal
  trigger, e-signature.
- `files/new-file-page.tsx` — Create + Forward-immediately flow.
- `tracking/file-tracking-history.tsx` + `timeline-modal.tsx` — Tracking
  History screen + the per-file timeline popup (with client-side PDF
  download via `lib/timeline-pdf.ts`).
- `admin/*` — User Management (incl. multi-role editing, bulk CSV,
  ownership transfer), Project Management (incl. Edit PI), Role
  Management.
- `search/search-page.tsx`.

### 9.3 Shared building blocks (`components/shared/`)
Reuse these — do not re-implement:
- `searchable-select.tsx` — the one dropdown-with-search component used
  everywhere. `widePanel` prop (default off) lets the open panel grow
  past the trigger width for long option labels (recipient pickers).
- `table-controls.tsx` — `useTableSearchSort()` hook + `TableSearchInput`
  + `SortTh`. Search-all-columns + click-to-sort, layered on top of...
- `table-pagination.tsx` — `paginate()` + `TablePagination`, 15 rows/page.
- `rich-text-editor.tsx` — the shared TipTap config (toolbar, highlight
  colour picker, paste-cleanup for Word/LibreOffice HTML).
- `page-header.tsx`, `person-badge.tsx`, `file-classification-badge.tsx`,
  `office-section-filter.tsx`, `empty-state.tsx`.

### 9.4 Hooks (`hooks/`)
- `use-favorite-recipients.ts` — `personLabel()` (how a recipient renders
  in a dropdown, including the `"<id>::<role>"` composite value for
  multi-role people and the `PI<n> · <project>` format for PI profiles),
  `buildGroups()`, `splitRecipientValue()`.
- `use-recipient-filter.ts` — the Office/Section cascade feeding the
  recipient list.
- `use-attachment-queue.ts` — local-queue-then-upload-on-submit pattern
  used by New File; immediate-upload variant used by Forward.
- `use-my-profiles.ts` — `switchToProfile()`, `switchToRole()`.
- `use-unsaved-changes-guard.ts` — blocks navigation with unsaved edits.

### 9.5 Auth & API plumbing
- `stores/auth.store.ts` — Zustand, persisted. `setAuth()` derives
  `activeRole` from `user.active_role` (falls back to `roles[0]`).
  **Note:** `active_role` lives on the shared DB row (§6.4's caveat) — the
  frontend just reflects whatever the last token said.
- `services/api.ts` — axios instance; request interceptor attaches the
  bearer token from `localStorage`; response interceptor handles 401 by
  transparently refreshing (with a request queue so concurrent 401s don't
  each trigger their own refresh) and redirects to `/login` if refresh
  itself fails.

### 9.6 Notable UI conventions established this project
- **Sidebar** collapsed by default, explicit "Expand" button.
- **Every data table** gets search-all-columns + sortable headers
  (`table-controls.tsx`) and 15-row pagination.
- **Notesheet reading order**: latest note at top, the creator's original
  at the bottom, the current holder's own editor last.
- A blank/placeholder note is never rendered as if it were real content —
  see `hasRealNotesheetContent()` / `isNotesheetEmpty()` in `lib/utils.ts`.
- Theme colours: `--avfu-teal #0D6E6E`, `--avfu-gold #C6902B`,
  `--ink #1A1A1A` (see any component for the literal hex — no CSS
  variables file exists yet, they're inlined via Tailwind arbitrary values).

---

## 10. Where to look when...

| You need to... | Start here |
|---|---|
| Add a field to the New File form | `frontend/modules/files/new-file-page.tsx` + `backend/app/schemas/efms.py` (`FileCreate`) + `create_file` in `efms_files.py` |
| Change who can see a file | §7 — extend one of the `_has_*`/`_assert_*` helpers, don't add a new inline check |
| Add a new workflow action (beyond Forward/Dispatch/Release) | `route_file` in `efms_files.py` is the pattern to follow — it's the one place status/holder/holding-period all change together |
| Add a column that needs to survive across every environment | Write an Alembic migration (`alembic revision -m "..."`), nullable, no backfill unless truly required — see §5's rule |
| Change what a PI profile snapshots from its origin | `_create_project_profile()` in `projects.py` |
| Change per-role scoping rules | The `_in_role_hold` / `_in_role_created` `or_()` clauses in `list_files` (`efms_files.py`) and the equivalent in `my_docket` (`docket.py`) |
| Add a new admin lookup table | Follow the `file_categories`/`file_priorities` pattern in `admin.py` — simple CRUD + `/all` variant that ignores `is_active` for edit-screen dropdowns |
| Debug a 500 that "should" work | Check `alembic current` on that environment first — see §5 |
| Understand the recipient dropdown value format | `"<userId>::<role>"` — `splitRecipientValue()` in `use-favorite-recipients.ts` |

---

## 11. Known gaps / things flagged but not fixed

- **`active_role` is per-user, not per-session** (§6.4) — two concurrent
  sessions as the same identity in different roles will interfere.
- `frontend/modules/files/files-list-page.tsx` exists but isn't routed
  anywhere (`/files` redirects to `/dashboard`) — confirm intent before
  building on it.
- `file_remarks` table's exact relationship to `route_entries.remarks` /
  `holder_notes` should be re-examined before adding new remark features —
  there may be redundant paths.
- E-signature "dongle" integration was discussed but never scoped/built —
  ask before assuming `file_signatures`/`signing.py` covers a hardware
  dongle flow; today it's OTP-verified only.
- No automated test suite currently exists for either side — every
  feature in this doc was verified via live API calls / driven browser
  sessions during development, not committed tests. Adding pytest
  (backend) / Playwright (frontend) coverage would be high-value.

---

## 12. Credentials for local testing

15 dummy accounts from `backend/seed.py`, all `@avfu.ac.in`, password
`Admin@123`, 2-step OTP login (OTP is emailed via the configured SMTP, or
read from the `otps` table in dev). Never run `seed.py` against a real
environment — see §2.
