"""AVFU eFMS — one-time pre-client-handover data reset utility.

Deletes every test/dummy user, project, establishment, department, category,
eFMS file, and everything transactionally dependent on them, while
preserving:

  - exactly one user: superadmin@avfu.ac.in
  - exactly one role: the existing system "super_admin" role
  - every row in file_priorities, completely untouched
  - the "otps" table, completely untouched (OTP configuration/data is out
    of scope for this utility — see the investigation report)
  - avfu_logo.png and every other static application asset

THIS IS NOT AN ALEMBIC MIGRATION. It never touches the schema, never
creates/drops a table, and never runs DDL. It only deletes/updates rows via
plain parameterized SQL, run once, by hand, against a specific environment.

── Why raw SQL instead of the ORM ──────────────────────────────────────────
Two independent facts, both confirmed against the actual migrated schema
(not just the SQLAlchemy models) during the investigation this script
implements:

 1. Several parent/child relationships that carry `cascade="all,
    delete-orphan"` at the ORM/relationship level (EfmsFile.notesheet,
    .holder_notes, .route_entries, .attachments) do NOT have a matching
    `ON DELETE CASCADE` at the actual database level (verified directly
    against alembic/versions/0001_initial_schema.py). A raw
    `DELETE FROM efms_files` — or an ORM `session.delete(file_obj)` that
    for any reason skips the relationship-cascade code path — will raise a
    foreign-key violation unless notesheets/notesheet_versions/
    route_entries/holder_notes/file_attachments/dispatch_records are
    deleted first. This script deletes them first, explicitly, in the
    order documented in DELETION_ORDER below.
 2. The `AuditLog` SQLAlchemy model declares columns (`resource_type`,
    `user_agent`) that do not exist in the actual migrated `audit_logs`
    table (whose real columns are `resource`, no `user_agent` — see
    alembic/versions/0001_initial_schema.py). Any ORM-level SELECT/DELETE
    against `AuditLog`, or any relationship load of `User.audit_logs`
    (which SQLAlchemy's cascade resolution can trigger when you
    `session.delete(a_user)`), raises `UndefinedColumnError`. This script
    only ever issues a bare `DELETE FROM audit_logs` with no column
    references, which is unaffected by that drift.

── Safety model ─────────────────────────────────────────────────────────────
 - --dry-run: 100% read-only. Every number shown comes from a plain
   `SELECT COUNT(*)` / `SELECT` — no DELETE/UPDATE statement is ever built
   or executed in this mode.
 - --execute: prints the resolved target host/port/database/user and requires
   the operator to type it back as "RESET AVFU EFMS DATABASE <db_name>" —
   an independent guard against DATABASE_URL accidentally pointing at the
   wrong server/environment — BEFORE requiring a backup and opening a
   transaction; resolves and verifies the exact Super Admin to keep BEFORE
   opening a transaction; requires the operator to type the exact phrase
   "RESET AVFU EFMS" (or pass it via --confirm, for scripted/CI use against
   a non-production database only); runs the entire deletion sequence
   inside one `engine.begin()` transaction; runs every verification check
   from the investigation report against that same open transaction; if
   ANY check fails, raises — which auto-rolls-back the transaction — and
   exits non-zero without ever reaching COMMIT. Filesystem cleanup is a
   SEPARATE, later phase, gated by its own explicit confirmation, and only
   ever reachable after the database transaction has already committed.

Usage:
    python -m scripts.reset_for_handover --dry-run
    python -m scripts.reset_for_handover --execute \
        [--confirm-database "RESET AVFU EFMS DATABASE <db_name>"] \
        [--confirm "RESET AVFU EFMS"] \
        [--skip-backup-check | --backup-file PATH]
"""
from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

# Imported lazily-but-at-module-level is fine here: this script is always
# invoked as its own process (`python -m scripts.reset_for_handover`), so
# whatever DATABASE_URL/UPLOAD_DIR are set in ITS environment (e.g. by a
# test harness, to point at a throwaway database/directory) are exactly
# what app.core.config.settings will read — nothing in this file hardcodes
# either value.
from app.core.config import settings
from app.db.base import engine

SUPER_ADMIN_EMAIL = "superadmin@avfu.ac.in"
SUPER_ADMIN_ROLE_NAME = "super_admin"
CONFIRMATION_PHRASE = "RESET AVFU EFMS"
UPLOAD_CONFIRMATION_PHRASE = "CLEAN UPLOADS"
DB_NAME_CONFIRMATION_PREFIX = "RESET AVFU EFMS DATABASE"

# Directories this script must never operate on, even if UPLOAD_DIR somehow
# resolved to one of them (e.g. a misconfigured .env). Checked against the
# fully-resolved absolute path, so relative-path tricks ("./uploads/..")
# can't bypass it either.
_DANGEROUS_UPLOAD_DIRS = {
    Path("/"), Path("/opt"), Path("/opt/apps"), Path("/tmp"), Path("/home"),
    Path("/root"), Path("/etc"), Path("/var"), Path("/usr"), Path("/bin"),
    Path("/sbin"), Path("/lib"), Path("C:/"), Path("C:\\"),
}

# Purely transactional tables that are wiped unconditionally (no rows of
# these survive the reset either way — nothing here needs a WHERE clause).
# Order matters: see the module docstring and DELETION_ORDER's comments.
_BLANKET_DELETE_TABLES_BEFORE_FILES = [
    "notifications",
    "favorite_recipients",
    "file_recipients",
]
_EFMS_FILE_CHILD_TABLES = [
    "notesheet_versions",
    "notesheets",
    "route_entries",
    "holder_notes",
    "file_attachments",
    "dispatch_records",
    "dockets",
    "file_remarks",
    "file_signatures",
]

# Every table this utility inspects/reports on, for the before/after count
# report — includes tables that are NEVER deleted (file_priorities, otps)
# specifically so the report can show them as unchanged, not just omit them.
ALL_REPORTED_TABLES = [
    "users", "roles", "user_roles", "refresh_tokens", "favorite_recipients",
    "projects", "establishments", "departments", "file_categories",
    "file_priorities", "efms_files", "file_attachments", "notesheets",
    "notesheet_versions", "holder_notes", "route_entries", "dockets",
    "file_remarks", "file_signatures", "dispatch_records", "notifications",
    "file_recipients", "audit_logs", "otps",
]


class AbortReset(Exception):
    """Raised for any condition that must stop the reset before it makes a
    single write — never caught silently; always exits the process
    non-zero."""


@dataclass
class SuperAdmin:
    id: UUID
    email: str


@dataclass
class PriorityRow:
    id: UUID
    name: str
    label: str
    is_active: bool

    @classmethod
    def from_row(cls, row) -> "PriorityRow":
        return cls(id=row.id, name=row.name, label=row.label, is_active=row.is_active)


def _mask_db_url(url: str) -> str:
    """Never print a credential — only host/port/db name."""
    parts = urlsplit(url)
    host = parts.hostname or "?"
    port = parts.port or "?"
    db = (parts.path or "").lstrip("/")
    return f"{parts.scheme}://***:***@{host}:{port}/{db}"


def _resolve_db_target() -> tuple[str, int, str, str]:
    """Host/port/database/user of the configured DATABASE_URL — never the
    password. Read from the SQLAlchemy URL object directly (engine.url),
    not by re-parsing/echoing the raw connection string."""
    url = engine.url
    return (url.host or "?", url.port or 5432, url.database or "?", url.username or "?")


def _require_database_identity_confirmation(args: argparse.Namespace) -> str:
    """Prints exactly which server/database this run targets and requires
    the operator to type a phrase containing the ACTUAL resolved database
    name back — a second, independent guard against --execute accidentally
    being run with DATABASE_URL pointed at the wrong environment (e.g. a
    misconfigured .env aimed at production instead of the intended target).
    This is in addition to, not a replacement for, CONFIRMATION_PHRASE."""
    host, port, database, user = _resolve_db_target()
    print("\nTARGET DATABASE")
    print(f"  Host:     {host}")
    print(f"  Port:     {port}")
    print(f"  Database: {database}")
    print(f"  User:     {user}")
    expected = f"{DB_NAME_CONFIRMATION_PREFIX} {database}"
    phrase = args.confirm_database
    if phrase is None:
        phrase = input(f'Type "{expected}" to confirm this is the intended target database: ')
    if phrase != expected:
        raise AbortReset(
            f'Database identity confirmation did not match "{expected}" exactly. '
            "Aborting — refusing to proceed against an unconfirmed database."
        )
    return database


async def _count(conn: AsyncConnection, table: str) -> int:
    result = await conn.execute(text(f"SELECT COUNT(*) FROM {table}"))
    return result.scalar_one()


async def _resolve_super_admin(conn: AsyncConnection) -> SuperAdmin:
    """Resolves the ONE user to preserve strictly by email — never by role,
    never by "first row", never by any heuristic. Aborts (does not guess)
    if the account is missing or — given the investigation found 19 rows
    with active_role='super_admin' in the current dev database — if the
    email somehow matched more than once (it can't, given the existing
    UNIQUE constraint on users.email, but this is checked explicitly anyway
    rather than assumed)."""
    result = await conn.execute(
        text("SELECT id, email FROM users WHERE email = :email"),
        {"email": SUPER_ADMIN_EMAIL},
    )
    rows = result.all()
    if len(rows) == 0:
        raise AbortReset(
            f"No user found with email '{SUPER_ADMIN_EMAIL}'. Aborting — "
            "refusing to silently select a different Super Admin."
        )
    if len(rows) > 1:
        raise AbortReset(
            f"{len(rows)} users found with email '{SUPER_ADMIN_EMAIL}'. "
            "This should be impossible under the existing unique constraint "
            "on users.email — aborting rather than guessing which to keep."
        )
    return SuperAdmin(id=rows[0].id, email=rows[0].email)


async def _resolve_super_admin_role(conn: AsyncConnection) -> None:
    result = await conn.execute(
        text("SELECT id, is_system FROM roles WHERE name = :name"),
        {"name": SUPER_ADMIN_ROLE_NAME},
    )
    row = result.first()
    if row is None:
        raise AbortReset(
            f"No role named '{SUPER_ADMIN_ROLE_NAME}' exists in the roles "
            "table. Aborting — this script never creates roles."
        )
    if not row.is_system:
        raise AbortReset(
            f"The '{SUPER_ADMIN_ROLE_NAME}' role exists but is not marked "
            "is_system=true. Aborting rather than assuming it's safe to keep."
        )


async def _snapshot_priorities(conn: AsyncConnection) -> list[PriorityRow]:
    result = await conn.execute(
        text("SELECT id, name, label, is_active FROM file_priorities ORDER BY name")
    )
    return [PriorityRow.from_row(r) for r in result.all()]


def _assert_priorities_unchanged(before: list[PriorityRow], after: list[PriorityRow]) -> None:
    if before != after:
        raise AbortReset(
            "file_priorities changed during the reset — this must never "
            "happen. Aborting/rolling back. "
            f"before={before!r} after={after!r}"
        )


def resolve_upload_dir() -> Path:
    """Resolves the ACTUAL configured upload directory from the running
    application's own settings — never a hardcoded guess at the deployment
    path. Raises AbortReset if the resolved path is missing, is one of a
    known-dangerous broad system directory, or isn't literally named
    "uploads" (an extra guard against a misconfigured UPLOAD_DIR pointing
    somewhere it shouldn't)."""
    resolved = Path(settings.UPLOAD_DIR).resolve()
    if resolved in _DANGEROUS_UPLOAD_DIRS or resolved.parent == resolved:
        raise AbortReset(f"Refusing to operate on a suspicious path: {resolved}")
    if resolved.name.lower() != "uploads":
        raise AbortReset(
            f"Resolved UPLOAD_DIR does not end in a directory literally "
            f"named 'uploads': {resolved}. Refusing to proceed."
        )
    if not resolved.is_dir():
        raise AbortReset(f"Resolved UPLOAD_DIR does not exist as a directory: {resolved}")
    return resolved


def _list_upload_dir_entries(upload_dir: Path) -> list[Path]:
    return sorted(upload_dir.iterdir())


# ── Dry run ──────────────────────────────────────────────────────────────────

async def run_dry_run() -> None:
    print("=" * 60)
    print("AVFU eFMS HANDOVER RESET — DRY RUN")
    print("=" * 60)
    print(f"\nDatabase: {_mask_db_url(str(engine.url))}\n")

    async with engine.connect() as conn:  # plain read connection — no transaction, no writes
        super_admin = await _resolve_super_admin(conn)
        await _resolve_super_admin_role(conn)
        priorities = await _snapshot_priorities(conn)

        total_users = await _count(conn, "users")
        users_to_delete = total_users - 1
        total_roles = await _count(conn, "roles")
        roles_to_delete = await conn.scalar(text("SELECT COUNT(*) FROM roles WHERE is_system = false"))
        project_profile_users = await conn.scalar(
            text("SELECT COUNT(*) FROM users WHERE origin_user_id IS NOT NULL")
        )

        print("SUPER ADMIN TO KEEP")
        print(f"  Email: {super_admin.email}")
        print(f"  ID:    {super_admin.id}")

        print("\nDATA TO DELETE")
        print(f"  Users                : {users_to_delete}  (of {total_users} total; {project_profile_users} are project profiles)")
        print(f"  Roles                : {roles_to_delete}  (of {total_roles} total)")
        for table in ["projects", "establishments", "departments", "file_categories",
                      "efms_files", "file_attachments", "notesheets", "notesheet_versions",
                      "holder_notes", "route_entries", "dispatch_records", "dockets",
                      "file_remarks", "file_signatures", "notifications",
                      "favorite_recipients", "file_recipients", "audit_logs"]:
            print(f"  {table:20s} : {await _count(conn, table)}")

        print("\nDATA TO PRESERVE (unchanged)")
        print(f"  file_priorities      : {len(priorities)}")
        for p in priorities:
            print(f"      - {p.name} ({p.label}) active={p.is_active} id={p.id}")
        print(f"  otps                 : {await _count(conn, 'otps')}  (left untouched — out of scope)")

        try:
            upload_dir = resolve_upload_dir()
            entries = _list_upload_dir_entries(upload_dir)
            print("\nUPLOAD DIRECTORY")
            print(f"  {upload_dir}")
            print(f"  Files/entries currently present: {len(entries)}")
        except AbortReset as exc:
            print("\nUPLOAD DIRECTORY")
            print(f"  COULD NOT SAFELY RESOLVE: {exc}")

        print("\nNO DATA HAS BEEN MODIFIED.")


# ── Execute ──────────────────────────────────────────────────────────────────

DELETION_ORDER: list[tuple[str, str]] = [
    # (label, sql) — executed in exactly this order. Every ondelete behavior
    # referenced in these comments was verified directly against the actual
    # alembic migration files, not assumed from the ORM models.
    ("notifications (all)", "DELETE FROM notifications"),
    ("favorite_recipients (all)", "DELETE FROM favorite_recipients"),
    ("file_recipients (all)", "DELETE FROM file_recipients"),
    # eFMS-file children — NONE of these have ON DELETE CASCADE from
    # efms_files at the database level, so they must be removed before
    # efms_files itself or the DELETE below fails with a FK violation.
    ("notesheet_versions (all)", "DELETE FROM notesheet_versions"),
    ("notesheets (all)", "DELETE FROM notesheets"),
    ("route_entries (all)", "DELETE FROM route_entries"),
    ("holder_notes (all)", "DELETE FROM holder_notes"),
    ("file_attachments (all)", "DELETE FROM file_attachments"),
    ("dispatch_records (all)", "DELETE FROM dispatch_records"),
    # These three DO have ON DELETE CASCADE from efms_files already, but are
    # deleted explicitly anyway for an explicit, auditable log line — never
    # left to an implicit cascade.
    ("dockets (all)", "DELETE FROM dockets"),
    ("file_remarks (all)", "DELETE FROM file_remarks"),
    ("file_signatures (all)", "DELETE FROM file_signatures"),
    ("efms_files (all)", "DELETE FROM efms_files"),
    # Break the department<->user RESTRICT cycle before any user is deleted.
    ("departments.head_of_department_id -> NULL", "UPDATE departments SET head_of_department_id = NULL"),
    # Break the project<->profile-user RESTRICT cycle (users.project_id and
    # projects.current_profile_id both RESTRICT with no ondelete).
    ("projects.current_profile_id -> NULL", "UPDATE projects SET current_profile_id = NULL"),
    ("project-profile users (origin_user_id IS NOT NULL)", "DELETE FROM users WHERE origin_user_id IS NOT NULL"),
    ("projects (all)", "DELETE FROM projects"),
    # Every remaining non-Super-Admin user. Cascades user_roles,
    # refresh_tokens, and favorite_recipients for them automatically
    # (ON DELETE CASCADE, verified in migration 0001) — Super Admin's own
    # rows in those tables are untouched since Super Admin is never deleted.
    ("users (all except Super Admin)", "DELETE FROM users WHERE id != :super_admin_id"),
    # By this point the only remaining user is the preserved Super Admin.
    # users.department_id/establishment_id have no ondelete clause (verified
    # in alembic/versions/0001_initial_schema.py:77-78) and are RESTRICT by
    # default, so the Super Admin's own department/establishment reference
    # would otherwise block deleting the very row it points to — this is
    # the exact failure a real handover run hit at "DELETE FROM
    # departments" (users_department_id_fkey). Clearing the reference does
    # not delete or rename the department/establishment itself — it only
    # detaches the preserved user's now-meaningless department/establishment
    # link, immediately before those rows are removed anyway.
    ("users.department_id -> NULL (all remaining users)", "UPDATE users SET department_id = NULL"),
    ("departments (all)", "DELETE FROM departments"),
    ("users.establishment_id -> NULL (all remaining users)", "UPDATE users SET establishment_id = NULL"),
    ("establishments (all)", "DELETE FROM establishments"),
    ("file_categories (all)", "DELETE FROM file_categories"),
    ("roles (all non-system)", "DELETE FROM roles WHERE is_system = false"),
    # No column is referenced here, so the resource_type/user_agent model
    # vs. actual-table drift documented in the module docstring cannot
    # affect this statement.
    ("audit_logs (all)", "DELETE FROM audit_logs"),
]


async def _run_deletion_sequence(conn: AsyncConnection, super_admin: SuperAdmin) -> None:
    for label, sql in DELETION_ORDER:
        params = {"super_admin_id": super_admin.id} if ":super_admin_id" in sql else {}
        result = await conn.execute(text(sql), params)
        print(f"  [{result.rowcount:>4}] {label}")


async def _verify_after_state(
    conn: AsyncConnection, super_admin: SuperAdmin, priorities_before: list[PriorityRow]
) -> None:
    """Every check here must pass or the caller must not commit. Raising
    AbortReset from inside the open transaction causes engine.begin() to
    roll back automatically — nothing needs to call rollback() explicitly."""
    checks: list[tuple[str, bool]] = []

    users = await _count(conn, "users")
    checks.append((f"users == 1 (got {users})", users == 1))

    still_super_admin = await conn.scalar(
        text("SELECT COUNT(*) FROM users WHERE id = :id AND email = :email"),
        {"id": super_admin.id, "email": super_admin.email},
    )
    checks.append(("preserved user is still the exact Super Admin row", still_super_admin == 1))

    super_admin_org_refs_cleared = await conn.scalar(
        text(
            "SELECT COUNT(*) FROM users "
            "WHERE id = :id AND department_id IS NULL AND establishment_id IS NULL"
        ),
        {"id": super_admin.id},
    )
    checks.append(
        ("Super Admin department_id/establishment_id are NULL", super_admin_org_refs_cleared == 1)
    )

    roles = await _count(conn, "roles")
    checks.append((f"roles == 1 (got {roles})", roles == 1))
    remaining_role_is_system = await conn.scalar(text("SELECT COUNT(*) FROM roles WHERE is_system = true"))
    checks.append(("remaining role is_system == true", remaining_role_is_system == 1))

    priorities_after = await _snapshot_priorities(conn)
    checks.append((f"file_priorities unchanged ({len(priorities_after)} rows)", priorities_after == priorities_before))

    for table in ["projects", "establishments", "departments", "file_categories",
                  "efms_files", "file_attachments", "notesheets", "notesheet_versions",
                  "holder_notes", "route_entries", "dispatch_records", "dockets",
                  "file_remarks", "file_signatures", "notifications",
                  "favorite_recipients", "file_recipients", "audit_logs"]:
        n = await _count(conn, table)
        checks.append((f"{table} == 0 (got {n})", n == 0))

    project_profile_users = await conn.scalar(text("SELECT COUNT(*) FROM users WHERE origin_user_id IS NOT NULL"))
    checks.append((f"project-profile users == 0 (got {project_profile_users})", project_profile_users == 0))

    orphan_attachments = await conn.scalar(text(
        "SELECT COUNT(*) FROM file_attachments fa "
        "LEFT JOIN efms_files f ON f.id = fa.file_id WHERE f.id IS NULL"
    ))
    checks.append((f"no orphan file_attachments (got {orphan_attachments})", orphan_attachments == 0))

    otps_untouched = await _count(conn, "otps")
    checks.append((f"otps left untouched (informational, currently {otps_untouched})", True))

    print("\nVERIFICATION")
    failed = []
    for description, passed in checks:
        status = "OK " if passed else "FAIL"
        print(f"  [{status}] {description}")
        if not passed:
            failed.append(description)

    if failed:
        raise AbortReset(f"{len(failed)} verification check(s) failed: {failed}")


def _print_backup_reminder() -> None:
    host, port, database, user = _resolve_db_target()
    print("\nBACKUP REQUIRED BEFORE PROCEEDING")
    print("  This script never creates the backup itself, and never reads, stores, or")
    print("  logs the database password. Authenticate via a ~/.pgpass file (or another")
    print("  standard libpq mechanism) rather than putting the password on the command")
    print("  line, where it would be exposed in shell history and process listings:")
    print(f"    echo '{host}:{port}:{database}:{user}:<password>' >> ~/.pgpass")
    print("    chmod 600 ~/.pgpass")
    print("  Then take the backup (no password on the command line):")
    print(
        f"    pg_dump -h {host} -p {port} -U {user} -d {database} "
        f"-F c -f avfu_efms_backup_$(date +%Y%m%d_%H%M%S).dump"
    )


def _require_backup_evidence(args: argparse.Namespace) -> None:
    if args.skip_backup_check:
        print("\n" + "!" * 66)
        print("!! --skip-backup-check GIVEN — NOT VERIFYING A BACKUP EXISTS.        !!")
        print("!! If this database has not actually been backed up, this reset is   !!")
        print("!! UNRECOVERABLE. Use only as an explicit, deliberate emergency      !!")
        print("!! override — never as a default.                                   !!")
        print("!" * 66)
        return
    if not args.backup_file:
        raise AbortReset(
            "No --backup-file was given (and --skip-backup-check was not "
            "passed). Refusing to proceed without evidence a backup was "
            "taken. See the printed pg_dump command above."
        )
    backup_path = Path(args.backup_file)
    if not backup_path.is_file():
        raise AbortReset(f"--backup-file '{backup_path}' does not exist or is not a regular file.")
    if backup_path.stat().st_size == 0:
        raise AbortReset(f"--backup-file '{backup_path}' is empty.")
    print(f"\nBackup file verified present and non-empty: {backup_path} ({backup_path.stat().st_size} bytes)")

    try:
        result = subprocess.run(
            ["pg_restore", "--list", str(backup_path)],
            capture_output=True, text=True, timeout=30,
        )
    except FileNotFoundError:
        print(
            "  (pg_restore not found on PATH — skipping dump-format validation. "
            "Ensure this file is genuinely a PostgreSQL custom-format pg_dump backup.)"
        )
    else:
        if result.returncode != 0:
            raise AbortReset(
                f"--backup-file '{backup_path}' does not look like a valid PostgreSQL "
                f"custom-format dump (pg_restore --list failed): {result.stderr.strip()}"
            )
        print("  pg_restore --list confirms this is a readable PostgreSQL custom-format dump.")


def _require_confirmation(args: argparse.Namespace, super_admin: SuperAdmin) -> None:
    print("\nWARNING:")
    print("This will permanently delete AVFU eFMS test data.\n")
    print("The following user will be preserved:\n")
    print(f"  {super_admin.email}")
    print(f"  {super_admin.id}\n")
    print("All other users and specified transactional/master data will be deleted.\n")
    phrase = args.confirm
    if phrase is None:
        phrase = input(f'Type "{CONFIRMATION_PHRASE}" to proceed: ')
    if phrase != CONFIRMATION_PHRASE:
        raise AbortReset(f'Confirmation phrase did not match "{CONFIRMATION_PHRASE}" exactly. Aborting.')


def _require_filesystem_confirmation(args: argparse.Namespace, upload_dir: Path, entry_count: int) -> bool:
    print("\nDATABASE TRANSACTION COMMITTED SUCCESSFULLY.")
    print("\nPHASE 5 — FILESYSTEM CLEANUP (separate from the database transaction)")
    print(f"  Resolved upload directory: {upload_dir}")
    print(f"  Entries currently present: {entry_count}")
    print("  The directory itself will NOT be deleted — only its contents.")
    phrase = args.confirm_uploads
    if phrase is None:
        phrase = input(f'Type "{UPLOAD_CONFIRMATION_PHRASE}" to empty this directory now, or press Enter to skip: ')
    return phrase == UPLOAD_CONFIRMATION_PHRASE


def clean_upload_dir(upload_dir: Path) -> int:
    """Deletes every entry INSIDE the already-safety-verified upload_dir,
    never the directory itself, and never any path this function did not
    resolve/verify itself. No bare shutil.rmtree(upload_dir) is ever called."""
    import shutil

    removed = 0
    for entry in _list_upload_dir_entries(upload_dir):
        if entry.is_dir():
            shutil.rmtree(entry)
        else:
            entry.unlink()
        removed += 1
    return removed


async def _print_final_summary(
    super_admin: SuperAdmin,
    priorities: list[PriorityRow],
    upload_removed: int | None,
    upload_remaining: int | None,
) -> None:
    async with engine.connect() as conn:
        users = await _count(conn, "users")
        roles = await _count(conn, "roles")
        projects = await _count(conn, "projects")
        establishments = await _count(conn, "establishments")
        departments = await _count(conn, "departments")
        categories = await _count(conn, "file_categories")
        transactional_counts = {
            table: await _count(conn, table)
            for table in [
                "efms_files", "file_attachments", "notesheets", "notesheet_versions",
                "holder_notes", "route_entries", "dispatch_records", "dockets",
                "file_remarks", "file_signatures", "notifications",
                "favorite_recipients", "file_recipients", "audit_logs",
            ]
        }
        otps = await _count(conn, "otps")

    print("\n" + "=" * 60)
    print("FINAL VERIFICATION SUMMARY")
    print("=" * 60)
    print(f"  Preserved Super Admin      : {super_admin.email}")
    print(f"  Final user count           : {users}")
    print(f"  Final role count           : {roles}")
    print(f"  Final project count        : {projects}")
    print(f"  Final establishment count  : {establishments}")
    print(f"  Final department count     : {departments}")
    print(f"  Final category count       : {categories}")
    print("  Final eFMS transactional-record counts:")
    for table, n in transactional_counts.items():
        print(f"      {table:20s}: {n}")
    print(f"  Preserved priorities       : {len(priorities)} ({', '.join(p.name for p in priorities)})")
    print(f"  OTP rows                   : {otps} (untouched — out of scope for this reset)")
    if upload_removed is None:
        print("  Upload directory cleanup   : SKIPPED by operator")
    else:
        print(f"  Upload directory cleanup   : {upload_removed} entries removed, {upload_remaining} remaining")
    print("=" * 60)


async def run_execute(args: argparse.Namespace) -> None:
    print("=" * 60)
    print("AVFU eFMS HANDOVER RESET — EXECUTE")
    print("=" * 60)
    print(f"\nDatabase: {_mask_db_url(str(engine.url))}\n")

    _require_database_identity_confirmation(args)
    _print_backup_reminder()
    _require_backup_evidence(args)

    async with engine.connect() as pre_conn:
        super_admin = await _resolve_super_admin(pre_conn)
        await _resolve_super_admin_role(pre_conn)
        priorities_before = await _snapshot_priorities(pre_conn)
        total_users = await _count(pre_conn, "users")
        upload_dir = resolve_upload_dir()
        upload_entries_before = len(_list_upload_dir_entries(upload_dir))

    print("\nSuper Admin to preserve:")
    print(f"  Email: {super_admin.email}")
    print(f"  ID:    {super_admin.id}")
    print(f"\nUsers found: {total_users}")
    print(f"User to preserve:\n  {super_admin.email}\n  {super_admin.id}")
    print(f"\nUsers to delete: {total_users - 1}")
    print(f"\nPriorities to preserve (unchanged): {len(priorities_before)}")

    _require_confirmation(args, super_admin)

    print("\nPHASE 2/3/4 — DATABASE TRANSACTION")
    async with engine.begin() as conn:  # auto-commits on clean exit, auto-rolls-back on exception
        await _run_deletion_sequence(conn, super_admin)
        await _verify_after_state(conn, super_admin, priorities_before)
        # Reaching here with no exception raised means every check passed;
        # exiting this `async with` block now commits.

    print("\n[DATABASE TRANSACTION COMMITTED]")

    upload_removed: int | None = None
    upload_remaining: int | None = None
    if _require_filesystem_confirmation(args, upload_dir, upload_entries_before):
        upload_removed = clean_upload_dir(upload_dir)
        upload_remaining = len(_list_upload_dir_entries(upload_dir))
        print(f"\nPHASE 6 — removed {upload_removed} entries from {upload_dir}")
        print(f"PHASE 7 — verification: entries remaining = {upload_remaining} (expected 0)")
        if upload_remaining != 0:
            print("WARNING: upload directory is not empty after cleanup — inspect manually.")
    else:
        print("\nFilesystem cleanup SKIPPED by operator. Run this utility's cleanup step "
              "manually later, or re-run with --execute (the DB portion will simply find "
              "nothing left to delete and pass verification trivially).")

    await _print_final_summary(super_admin, priorities_before, upload_removed, upload_remaining)

    print("\nRESET COMPLETE.")


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="Read-only report. Modifies nothing.")
    mode.add_argument("--execute", action="store_true", help="Perform the actual reset. Destructive.")
    parser.add_argument("--confirm-database", default=None, help='Non-interactive database-identity confirmation (must exactly equal "%s <database name>"). For scripted use against a non-production database only.' % DB_NAME_CONFIRMATION_PREFIX)
    parser.add_argument("--confirm", default=None, help='Non-interactive confirmation phrase (must exactly equal "%s"). For scripted use against a non-production database only.' % CONFIRMATION_PHRASE)
    parser.add_argument("--confirm-uploads", default=None, help='Non-interactive filesystem-cleanup confirmation (must exactly equal "%s").' % UPLOAD_CONFIRMATION_PHRASE)
    parser.add_argument("--backup-file", default=None, help="Path to a pg_dump backup file taken immediately before running --execute.")
    parser.add_argument("--skip-backup-check", action="store_true", help="Bypass the backup-file check. Not recommended.")
    return parser.parse_args(argv)


async def _amain(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        if args.dry_run:
            await run_dry_run()
        else:
            await run_execute(args)
        return 0
    except AbortReset as exc:
        print(f"\nABORTED: {exc}", file=sys.stderr)
        return 1
    finally:
        await engine.dispose()


def main() -> None:
    sys.exit(asyncio.run(_amain()))


if __name__ == "__main__":
    main()
