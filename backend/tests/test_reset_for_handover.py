"""Tests for scripts/reset_for_handover.py.

Per the explicit requirement this utility was built under, THESE TESTS NEVER
TOUCH THE REAL aau_db DATABASE OR THE REAL uploads/ DIRECTORY. Every test in
this file operates against a brand-new, uniquely-named, throwaway Postgres
database created at the start of the test session and dropped at the end,
whose schema is a hand-written reproduction of just the ~23 tables this
utility touches — faithfully matching the exact ON DELETE behavior verified
against the real Alembic migrations (see reset_for_handover.py's module
docstring and DELETION_ORDER comments for the citations).

Two testing styles are used:

  - "Unit" tests call the script's internal functions directly against a
    throwaway-database connection this test file opens itself (never the
    app-wide `app.db.base.engine` singleton, which is bound to the real
    database as soon as anything imports app.main/conftest).
  - "CLI" tests invoke `python -m scripts.reset_for_handover` as a real
    subprocess with DATABASE_URL/UPLOAD_DIR overridden in that subprocess's
    environment only — this is the only way to exercise run_dry_run()/
    run_execute(), since those two functions use the module-level `engine`
    that is bound once, at import time, to whatever DATABASE_URL the
    *importing* process had at that moment.
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import uuid
from pathlib import Path

import asyncpg
import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

BACKEND_DIR = Path(__file__).resolve().parent.parent
REAL_DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql+asyncpg://postgres:password@localhost:5432/aau_db"
)


def _admin_dsn() -> str:
    """asyncpg DSN (no +asyncpg suffix) pointing at the `postgres` maintenance
    database on the same server as REAL_DATABASE_URL — used only to
    CREATE/DROP the throwaway test database itself."""
    plain = REAL_DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")
    head, _, _tail_db = plain.rpartition("/")
    return f"{head}/postgres"


def _test_db_name() -> str:
    return f"avfu_efms_reset_test_{uuid.uuid4().hex[:12]}"


SCHEMA_SQL = """
CREATE TABLE roles (
    id UUID PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT, is_system BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE projects (
    id UUID PRIMARY KEY, project_number TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', current_profile_id UUID, created_by UUID
);
CREATE TABLE users (
    id UUID PRIMARY KEY, email TEXT UNIQUE NOT NULL, hashed_password TEXT,
    first_name TEXT, last_name TEXT, is_active BOOLEAN NOT NULL DEFAULT true,
    active_role TEXT, origin_user_id UUID REFERENCES users(id),
    project_id UUID REFERENCES projects(id), deactivated_by UUID REFERENCES users(id),
    department_id UUID, establishment_id UUID
);
ALTER TABLE projects ADD CONSTRAINT fk_projects_current_profile FOREIGN KEY (current_profile_id) REFERENCES users(id);
ALTER TABLE projects ADD CONSTRAINT fk_projects_created_by FOREIGN KEY (created_by) REFERENCES users(id);
CREATE TABLE user_roles (
    id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL
);
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT NOT NULL, revoked BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE establishments (id UUID PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE departments (
    id UUID PRIMARY KEY, name TEXT NOT NULL,
    establishment_id UUID REFERENCES establishments(id),
    head_of_department_id UUID REFERENCES users(id)
);
-- users.department_id/establishment_id are RESTRICT with no ondelete clause,
-- exactly matching alembic/versions/0001_initial_schema.py:77-78 — added
-- only now that departments/establishments exist, same deferred-FK pattern
-- already used above for the projects<->users circular reference.
ALTER TABLE users ADD CONSTRAINT fk_users_department FOREIGN KEY (department_id) REFERENCES departments(id);
ALTER TABLE users ADD CONSTRAINT fk_users_establishment FOREIGN KEY (establishment_id) REFERENCES establishments(id);
CREATE TABLE file_categories (id UUID PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE file_priorities (
    id UUID PRIMARY KEY, name TEXT UNIQUE NOT NULL, label TEXT NOT NULL, is_active BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE efms_files (
    id UUID PRIMARY KEY, ref_number TEXT NOT NULL,
    created_by UUID REFERENCES users(id), current_holder_id UUID REFERENCES users(id),
    category_id UUID REFERENCES file_categories(id), priority_id UUID REFERENCES file_priorities(id)
);
CREATE TABLE notesheets (id UUID PRIMARY KEY, file_id UUID NOT NULL REFERENCES efms_files(id));
CREATE TABLE notesheet_versions (id UUID PRIMARY KEY, notesheet_id UUID NOT NULL REFERENCES notesheets(id));
CREATE TABLE route_entries (
    id UUID PRIMARY KEY, file_id UUID NOT NULL REFERENCES efms_files(id),
    from_user_id UUID REFERENCES users(id), to_user_id UUID REFERENCES users(id)
);
CREATE TABLE holder_notes (
    id UUID PRIMARY KEY, file_id UUID NOT NULL REFERENCES efms_files(id), user_id UUID REFERENCES users(id)
);
CREATE TABLE file_attachments (
    id UUID PRIMARY KEY, file_id UUID NOT NULL REFERENCES efms_files(id), uploaded_by UUID REFERENCES users(id),
    stored_path TEXT
);
CREATE TABLE dispatch_records (id UUID PRIMARY KEY, file_id UUID NOT NULL REFERENCES efms_files(id));
CREATE TABLE dockets (id UUID PRIMARY KEY, file_id UUID NOT NULL REFERENCES efms_files(id) ON DELETE CASCADE);
CREATE TABLE file_remarks (id UUID PRIMARY KEY, file_id UUID NOT NULL REFERENCES efms_files(id) ON DELETE CASCADE);
CREATE TABLE file_signatures (id UUID PRIMARY KEY, file_id UUID NOT NULL REFERENCES efms_files(id) ON DELETE CASCADE);
CREATE TABLE notifications (id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE favorite_recipients (
    id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE file_recipients (
    id UUID PRIMARY KEY, file_id UUID NOT NULL REFERENCES efms_files(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE audit_logs (id UUID PRIMARY KEY, user_id UUID, action TEXT NOT NULL);
CREATE TABLE otps (id UUID PRIMARY KEY, email TEXT NOT NULL, code TEXT NOT NULL);
"""

SUPER_ADMIN_EMAIL = "superadmin@avfu.ac.in"


@pytest_asyncio.fixture(scope="function")
async def test_db():
    """Creates a brand-new throwaway Postgres database with the reset
    script's schema, yields (sqlalchemy_url, asyncpg_dsn), then drops it.
    Function-scoped so every test starts from a clean, unmodified fixture."""
    db_name = _test_db_name()
    admin_dsn = _admin_dsn()

    admin_conn = await asyncpg.connect(admin_dsn)
    try:
        await admin_conn.execute(f'CREATE DATABASE "{db_name}"')
    finally:
        await admin_conn.close()

    plain = REAL_DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")
    head, _, _tail = plain.rpartition("/")
    asyncpg_dsn = f"{head}/{db_name}"
    sqlalchemy_url = f"postgresql+asyncpg://{asyncpg_dsn.split('://', 1)[1]}"

    conn = await asyncpg.connect(asyncpg_dsn)
    try:
        await conn.execute(SCHEMA_SQL)
    finally:
        await conn.close()

    try:
        yield sqlalchemy_url, asyncpg_dsn
    finally:
        admin_conn = await asyncpg.connect(admin_dsn)
        try:
            await admin_conn.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
                db_name,
            )
            await admin_conn.execute(f'DROP DATABASE IF EXISTS "{db_name}"')
        finally:
            await admin_conn.close()


def u() -> str:
    return str(uuid.uuid4())


async def seed_fixture_data(asyncpg_dsn: str) -> dict:
    """Seeds a realistic scenario: the real Super Admin, a same-role decoy,
    pytest-style leftover super-admin rows, ordinary users, a circular
    project/profile pair, a department with a head, and one eFMS file with
    every dependent-table row type populated — so the deletion order is
    genuinely exercised, not just declared. Returns the ids used so tests
    can assert against them."""
    conn = await asyncpg.connect(asyncpg_dsn)
    ids: dict[str, str] = {}
    try:
        ids["super_admin"] = u()
        ids["decoy_super_admin"] = u()
        ids["leftover1"] = u()
        ids["normal1"] = u()
        ids["normal2"] = u()
        ids["dept_head"] = u()
        ids["profile1"] = u()
        ids["profile2"] = u()
        ids["project1"] = u()
        ids["project2"] = u()
        ids["establishment1"] = u()
        ids["department1"] = u()
        ids["category1"] = u()
        ids["priority_high"] = u()
        ids["priority_medium"] = u()
        ids["priority_low"] = u()
        ids["file1"] = u()
        ids["role_super_admin"] = u()
        ids["role_editor"] = u()

        await conn.execute(
            "INSERT INTO roles (id, name, description, is_system) VALUES "
            "($1, 'super_admin', 'Super Admin', true), ($2, 'editor', 'Editor', false)",
            ids["role_super_admin"], ids["role_editor"],
        )

        # Users that must NOT be confused for the real Super Admin, despite
        # sharing active_role='super_admin' — resolution must be by email only.
        for key, email in [
            ("decoy_super_admin", "superadmin@aau.ac.in"),
            ("leftover1", "pytest.super_admin.abc123@example.test"),
        ]:
            await conn.execute(
                "INSERT INTO users (id, email, active_role, is_active) VALUES ($1, $2, 'super_admin', true)",
                ids[key], email,
            )

        await conn.execute(
            "INSERT INTO users (id, email, active_role, is_active) VALUES ($1, $2, 'super_admin', true)",
            ids["super_admin"], SUPER_ADMIN_EMAIL,
        )
        for key, email, role in [
            ("normal1", "user1@avfu.ac.in", "office_staff"),
            ("normal2", "user2@avfu.ac.in", "office_staff"),
            ("dept_head", "head@avfu.ac.in", "office_staff"),
        ]:
            await conn.execute(
                "INSERT INTO users (id, email, active_role, is_active) VALUES ($1, $2, $3, true)",
                ids[key], email, role,
            )

        # Circular project <-> profile-user references.
        # created_by intentionally references an ordinary user, not the Super
        # Admin — tests that delete the Super Admin directly (to simulate a
        # missing-Super-Admin scenario) must not trip an unrelated FK here.
        await conn.execute(
            "INSERT INTO projects (id, project_number, name, status, created_by) VALUES ($1, '1', 'Project One', 'active', $2)",
            ids["project1"], ids["normal1"],
        )
        await conn.execute(
            "INSERT INTO projects (id, project_number, name, status, created_by) VALUES ($1, '2', 'Project Two', 'active', $2)",
            ids["project2"], ids["normal1"],
        )
        await conn.execute(
            "INSERT INTO users (id, email, active_role, is_active, origin_user_id, project_id) VALUES "
            "($1, 'user1+pi1@avfu.ac.in', 'office_staff', true, $2, $3)",
            ids["profile1"], ids["normal1"], ids["project1"],
        )
        await conn.execute(
            "INSERT INTO users (id, email, active_role, is_active, origin_user_id, project_id) VALUES "
            "($1, 'user2+pi2@avfu.ac.in', 'office_staff', true, $2, $3)",
            ids["profile2"], ids["normal2"], ids["project2"],
        )
        await conn.execute("UPDATE projects SET current_profile_id = $1 WHERE id = $2", ids["profile1"], ids["project1"])
        await conn.execute("UPDATE projects SET current_profile_id = $1 WHERE id = $2", ids["profile2"], ids["project2"])

        await conn.execute("INSERT INTO establishments (id, name) VALUES ($1, 'AVFU HQ')", ids["establishment1"])
        await conn.execute(
            "INSERT INTO departments (id, name, establishment_id, head_of_department_id) VALUES ($1, 'Finance', $2, $3)",
            ids["department1"], ids["establishment1"], ids["dept_head"],
        )
        # Reproduces the exact real handover failure: the preserved Super
        # Admin itself has a department/establishment reference, which — if
        # left unset — blocks "DELETE FROM departments"/"DELETE FROM
        # establishments" via users_department_id_fkey/
        # users_establishment_id_fkey even after every other user is gone.
        await conn.execute(
            "UPDATE users SET department_id = $1, establishment_id = $2 WHERE id = $3",
            ids["department1"], ids["establishment1"], ids["super_admin"],
        )
        await conn.execute("INSERT INTO file_categories (id, name) VALUES ($1, 'General')", ids["category1"])
        await conn.execute(
            "INSERT INTO file_priorities (id, name, label, is_active) VALUES "
            "($1, 'high', 'High', true), ($2, 'medium', 'Medium', true), ($3, 'low', 'Low', true)",
            ids["priority_high"], ids["priority_medium"], ids["priority_low"],
        )

        await conn.execute(
            "INSERT INTO efms_files (id, ref_number, created_by, current_holder_id, category_id, priority_id) "
            "VALUES ($1, 'AVFU/GEN/2026/0001', $2, $3, $4, $5)",
            ids["file1"], ids["normal1"], ids["normal2"], ids["category1"], ids["priority_high"],
        )
        await conn.execute("INSERT INTO notesheets (id, file_id) VALUES ($1, $2)", u(), ids["file1"])
        notesheet_id = await conn.fetchval("SELECT id FROM notesheets WHERE file_id = $1", ids["file1"])
        await conn.execute("INSERT INTO notesheet_versions (id, notesheet_id) VALUES ($1, $2)", u(), notesheet_id)
        await conn.execute(
            "INSERT INTO route_entries (id, file_id, from_user_id, to_user_id) VALUES ($1, $2, $3, $4)",
            u(), ids["file1"], ids["normal1"], ids["normal2"],
        )
        await conn.execute("INSERT INTO holder_notes (id, file_id, user_id) VALUES ($1, $2, $3)", u(), ids["file1"], ids["normal2"])
        await conn.execute(
            "INSERT INTO file_attachments (id, file_id, uploaded_by, stored_path) VALUES ($1, $2, $3, 'AVFU_GEN_2026_0001/doc.pdf')",
            u(), ids["file1"], ids["normal1"],
        )
        await conn.execute("INSERT INTO dispatch_records (id, file_id) VALUES ($1, $2)", u(), ids["file1"])
        await conn.execute("INSERT INTO dockets (id, file_id) VALUES ($1, $2)", u(), ids["file1"])
        await conn.execute("INSERT INTO file_remarks (id, file_id) VALUES ($1, $2)", u(), ids["file1"])
        await conn.execute("INSERT INTO file_signatures (id, file_id) VALUES ($1, $2)", u(), ids["file1"])
        await conn.execute("INSERT INTO file_recipients (id, file_id, user_id) VALUES ($1, $2, $3)", u(), ids["file1"], ids["normal2"])
        await conn.execute("INSERT INTO notifications (id, user_id) VALUES ($1, $2)", u(), ids["normal1"])
        await conn.execute("INSERT INTO favorite_recipients (id, user_id, recipient_id) VALUES ($1, $2, $3)", u(), ids["normal1"], ids["normal2"])
        await conn.execute("INSERT INTO user_roles (id, user_id, role) VALUES ($1, $2, 'super_admin')", u(), ids["super_admin"])
        await conn.execute("INSERT INTO user_roles (id, user_id, role) VALUES ($1, $2, 'office_staff')", u(), ids["normal1"])
        await conn.execute("INSERT INTO refresh_tokens (id, user_id, token) VALUES ($1, $2, 'tok1')", u(), ids["normal1"])
        await conn.execute("INSERT INTO audit_logs (id, user_id, action) VALUES ($1, $2, 'login')", u(), ids["normal1"])
        await conn.execute("INSERT INTO otps (id, email, code) VALUES ($1, 'user1@avfu.ac.in', '123456')", u())
    finally:
        await conn.close()
    return ids


async def counts(asyncpg_dsn: str, tables: list[str]) -> dict:
    conn = await asyncpg.connect(asyncpg_dsn)
    try:
        return {t: await conn.fetchval(f"SELECT COUNT(*) FROM {t}") for t in tables}
    finally:
        await conn.close()


ALL_TABLES = [
    "users", "roles", "user_roles", "refresh_tokens", "favorite_recipients",
    "projects", "establishments", "departments", "file_categories",
    "file_priorities", "efms_files", "file_attachments", "notesheets",
    "notesheet_versions", "holder_notes", "route_entries", "dockets",
    "file_remarks", "file_signatures", "dispatch_records", "notifications",
    "file_recipients", "audit_logs", "otps",
]


def db_name_from_dsn(asyncpg_dsn: str) -> str:
    return asyncpg_dsn.rsplit("/", 1)[1]


def run_script(sqlalchemy_url: str, upload_dir: Path, extra_args: list[str]) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["DATABASE_URL"] = sqlalchemy_url
    env["UPLOAD_DIR"] = str(upload_dir)
    return subprocess.run(
        [sys.executable, "-m", "scripts.reset_for_handover", *extra_args],
        cwd=str(BACKEND_DIR),
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )


@pytest.fixture
def upload_dir(tmp_path) -> Path:
    # avfu_logo.png is NOT stored inside UPLOAD_DIR in the real app — see
    # app/api/v1/endpoints/efms_files.py:1134-1137, which resolves it from
    # the repository root, five parents above that file, entirely outside
    # UPLOAD_DIR. clean_upload_dir() only ever touches entries inside the
    # verified upload_dir, so that asset is naturally never at risk; this
    # fixture only needs an ordinary uploaded file to exercise cleanup.
    d = tmp_path / "uploads"
    d.mkdir()
    (d / "keep_me.txt").write_text("dummy uploaded file")
    return d


# ── CLI-level tests (subprocess, real module-level `engine`) ────────────────

@pytest.mark.asyncio
async def test_dry_run_modifies_nothing(test_db, upload_dir):
    sqlalchemy_url, asyncpg_dsn = test_db
    await seed_fixture_data(asyncpg_dsn)
    before = await counts(asyncpg_dsn, ALL_TABLES)

    result = run_script(sqlalchemy_url, upload_dir, ["--dry-run"])

    assert result.returncode == 0, result.stdout + result.stderr
    assert "DRY RUN" in result.stdout
    assert SUPER_ADMIN_EMAIL in result.stdout
    assert "NO DATA HAS BEEN MODIFIED." in result.stdout

    after = await counts(asyncpg_dsn, ALL_TABLES)
    assert before == after
    assert sorted(p.name for p in upload_dir.iterdir()) == ["keep_me.txt"]


@pytest.mark.asyncio
async def test_execute_wrong_confirmation_phrase_changes_nothing(test_db, upload_dir):
    sqlalchemy_url, asyncpg_dsn = test_db
    await seed_fixture_data(asyncpg_dsn)
    before = await counts(asyncpg_dsn, ALL_TABLES)
    db_name = db_name_from_dsn(asyncpg_dsn)

    result = run_script(
        sqlalchemy_url, upload_dir,
        ["--execute", "--skip-backup-check",
         "--confirm-database", f"RESET AVFU EFMS DATABASE {db_name}",
         "--confirm", "yes"],
    )

    assert result.returncode != 0
    assert "Confirmation phrase did not match" in result.stdout + result.stderr

    after = await counts(asyncpg_dsn, ALL_TABLES)
    assert before == after
    assert sorted(p.name for p in upload_dir.iterdir()) == ["keep_me.txt"]


@pytest.mark.asyncio
async def test_execute_wrong_database_name_confirmation_changes_nothing(test_db, upload_dir):
    """The new, independent database-identity guard: even with a perfectly
    correct RESET AVFU EFMS phrase, an incorrect/stale database-name
    confirmation must abort before anything else is checked or touched."""
    sqlalchemy_url, asyncpg_dsn = test_db
    await seed_fixture_data(asyncpg_dsn)
    before = await counts(asyncpg_dsn, ALL_TABLES)

    result = run_script(
        sqlalchemy_url, upload_dir,
        ["--execute", "--skip-backup-check",
         "--confirm-database", "RESET AVFU EFMS DATABASE some_other_db",
         "--confirm", "RESET AVFU EFMS"],
    )

    assert result.returncode != 0
    assert "Database identity confirmation did not match" in result.stdout + result.stderr

    after = await counts(asyncpg_dsn, ALL_TABLES)
    assert before == after
    assert sorted(p.name for p in upload_dir.iterdir()) == ["keep_me.txt"]


@pytest.mark.asyncio
async def test_execute_correct_database_name_confirmation_proceeds(test_db, upload_dir):
    """The mirror case: the correct database-name confirmation must let the
    run proceed past the identity gate (and, with every other confirmation
    also correct, all the way to a successful reset)."""
    sqlalchemy_url, asyncpg_dsn = test_db
    await seed_fixture_data(asyncpg_dsn)
    db_name = db_name_from_dsn(asyncpg_dsn)

    result = run_script(
        sqlalchemy_url, upload_dir,
        ["--execute", "--skip-backup-check",
         "--confirm-database", f"RESET AVFU EFMS DATABASE {db_name}",
         "--confirm", "RESET AVFU EFMS", "--confirm-uploads", "CLEAN UPLOADS"],
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "TARGET DATABASE" in result.stdout
    assert f"Database: {db_name}" in result.stdout  # from the TARGET DATABASE block
    assert "RESET COMPLETE." in result.stdout

    after_users = await counts(asyncpg_dsn, ["users"])
    assert after_users["users"] == 1


@pytest.mark.asyncio
async def test_execute_missing_backup_file_rejected(test_db, upload_dir):
    """Without --skip-backup-check and without --backup-file, the run must
    abort before touching anything, even once the database-identity and
    RESET AVFU EFMS phrases are both correct."""
    sqlalchemy_url, asyncpg_dsn = test_db
    await seed_fixture_data(asyncpg_dsn)
    before = await counts(asyncpg_dsn, ALL_TABLES)
    db_name = db_name_from_dsn(asyncpg_dsn)

    result = run_script(
        sqlalchemy_url, upload_dir,
        ["--execute",
         "--confirm-database", f"RESET AVFU EFMS DATABASE {db_name}",
         "--confirm", "RESET AVFU EFMS"],
    )

    assert result.returncode != 0
    assert "No --backup-file was given" in result.stdout + result.stderr

    after = await counts(asyncpg_dsn, ALL_TABLES)
    assert before == after


@pytest.mark.asyncio
async def test_execute_empty_backup_file_rejected(test_db, upload_dir, tmp_path):
    sqlalchemy_url, asyncpg_dsn = test_db
    await seed_fixture_data(asyncpg_dsn)
    before = await counts(asyncpg_dsn, ALL_TABLES)
    db_name = db_name_from_dsn(asyncpg_dsn)

    empty_backup = tmp_path / "empty_backup.dump"
    empty_backup.write_bytes(b"")

    result = run_script(
        sqlalchemy_url, upload_dir,
        ["--execute",
         "--confirm-database", f"RESET AVFU EFMS DATABASE {db_name}",
         "--confirm", "RESET AVFU EFMS",
         "--backup-file", str(empty_backup)],
    )

    assert result.returncode != 0
    assert "is empty" in result.stdout + result.stderr

    after = await counts(asyncpg_dsn, ALL_TABLES)
    assert before == after


@pytest.mark.asyncio
async def test_execute_missing_super_admin_aborts_safely(test_db, upload_dir):
    sqlalchemy_url, asyncpg_dsn = test_db
    ids = await seed_fixture_data(asyncpg_dsn)
    conn = await asyncpg.connect(asyncpg_dsn)
    try:
        # Remove the real Super Admin so the resolver must abort, not
        # silently fall back to the decoy same-role account.
        await conn.execute("DELETE FROM users WHERE email = $1", SUPER_ADMIN_EMAIL)
    finally:
        await conn.close()
    before = await counts(asyncpg_dsn, ALL_TABLES)
    db_name = db_name_from_dsn(asyncpg_dsn)

    result = run_script(
        sqlalchemy_url, upload_dir,
        ["--execute", "--skip-backup-check",
         "--confirm-database", f"RESET AVFU EFMS DATABASE {db_name}",
         "--confirm", "RESET AVFU EFMS"],
    )

    assert result.returncode != 0
    assert "No user found with email" in result.stdout + result.stderr

    after = await counts(asyncpg_dsn, ALL_TABLES)
    assert before == after


@pytest.mark.asyncio
async def test_super_admin_department_establishment_refs_do_not_block_reset(test_db, upload_dir):
    """Regression test for the real handover failure: DELETE FROM departments
    aborted on users_department_id_fkey because the preserved Super Admin's
    own department_id/establishment_id survive user deletion (Super Admin
    is never deleted). seed_fixture_data() always gives the Super Admin both
    references, exactly reproducing the reported scenario."""
    sqlalchemy_url, asyncpg_dsn = test_db
    ids = await seed_fixture_data(asyncpg_dsn)
    db_name = db_name_from_dsn(asyncpg_dsn)

    conn = await asyncpg.connect(asyncpg_dsn)
    try:
        before_row = await conn.fetchrow(
            "SELECT department_id, establishment_id FROM users WHERE email = $1", SUPER_ADMIN_EMAIL
        )
        assert before_row["department_id"] is not None
        assert before_row["establishment_id"] is not None
    finally:
        await conn.close()

    result = run_script(
        sqlalchemy_url, upload_dir,
        ["--execute", "--skip-backup-check",
         "--confirm-database", f"RESET AVFU EFMS DATABASE {db_name}",
         "--confirm", "RESET AVFU EFMS", "--confirm-uploads", "CLEAN UPLOADS"],
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "users_department_id_fkey" not in (result.stdout + result.stderr)

    conn = await asyncpg.connect(asyncpg_dsn)
    try:
        # 2. Departments and establishments are successfully deleted.
        assert await conn.fetchval("SELECT COUNT(*) FROM departments") == 0
        assert await conn.fetchval("SELECT COUNT(*) FROM establishments") == 0
        # 3. The preserved Super Admin remains.
        row = await conn.fetchrow(
            "SELECT id, department_id, establishment_id FROM users WHERE email = $1", SUPER_ADMIN_EMAIL
        )
        assert row is not None
        assert str(row["id"]) == ids["super_admin"]
        # 4. Its department_id and establishment_id are NULL after reset.
        assert row["department_id"] is None
        assert row["establishment_id"] is None
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_execute_full_reset_reaches_expected_final_state(test_db, upload_dir):
    sqlalchemy_url, asyncpg_dsn = test_db
    ids = await seed_fixture_data(asyncpg_dsn)
    db_name = db_name_from_dsn(asyncpg_dsn)

    result = run_script(
        sqlalchemy_url, upload_dir,
        ["--execute", "--skip-backup-check",
         "--confirm-database", f"RESET AVFU EFMS DATABASE {db_name}",
         "--confirm", "RESET AVFU EFMS", "--confirm-uploads", "CLEAN UPLOADS"],
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "RESET COMPLETE." in result.stdout
    assert "FINAL VERIFICATION SUMMARY" in result.stdout
    assert f"Preserved Super Admin      : {SUPER_ADMIN_EMAIL}" in result.stdout
    assert "Final user count           : 1" in result.stdout
    assert "Final role count           : 1" in result.stdout
    assert "Preserved priorities       : 3 (high, low, medium)" in result.stdout
    assert "OTP rows                   : 1 (untouched" in result.stdout
    assert "Upload directory cleanup   : 1 entries removed, 0 remaining" in result.stdout

    conn = await asyncpg.connect(asyncpg_dsn)
    try:
        assert await conn.fetchval("SELECT COUNT(*) FROM users") == 1
        remaining_email = await conn.fetchval("SELECT email FROM users")
        assert remaining_email == SUPER_ADMIN_EMAIL
        assert await conn.fetchval("SELECT COUNT(*) FROM roles") == 1
        assert await conn.fetchval("SELECT is_system FROM roles LIMIT 1") is True
        for table in [
            "projects", "establishments", "departments", "file_categories",
            "efms_files", "file_attachments", "notesheets", "notesheet_versions",
            "holder_notes", "route_entries", "dispatch_records", "dockets",
            "file_remarks", "file_signatures", "notifications",
            "favorite_recipients", "file_recipients", "audit_logs",
        ]:
            assert await conn.fetchval(f"SELECT COUNT(*) FROM {table}") == 0, table
        assert await conn.fetchval("SELECT COUNT(*) FROM users WHERE origin_user_id IS NOT NULL") == 0
        super_admin_row = await conn.fetchrow("SELECT department_id, establishment_id FROM users LIMIT 1")
        assert super_admin_row["department_id"] is None
        assert super_admin_row["establishment_id"] is None
        assert await conn.fetchval("SELECT COUNT(*) FROM file_priorities") == 3
        priority_names = {r["name"] for r in await conn.fetch("SELECT name FROM file_priorities")}
        assert priority_names == {"high", "medium", "low"}
        # otps must be left completely untouched
        assert await conn.fetchval("SELECT COUNT(*) FROM otps") == 1
    finally:
        await conn.close()

    assert list(upload_dir.iterdir()) == [], "uploads/ must end up empty"
    assert upload_dir.is_dir(), "the uploads directory itself must be preserved, not deleted"


# ── Unit-level tests against internal functions (direct DB connection) ─────

@pytest_asyncio.fixture
async def module():
    sys.path.insert(0, str(BACKEND_DIR))
    import importlib
    mod = importlib.import_module("scripts.reset_for_handover")
    yield mod


@pytest.mark.asyncio
async def test_resolve_super_admin_ignores_same_role_decoys(test_db, module):
    sqlalchemy_url, asyncpg_dsn = test_db
    ids = await seed_fixture_data(asyncpg_dsn)
    engine = create_async_engine(sqlalchemy_url)
    try:
        async with engine.connect() as conn:
            resolved = await module._resolve_super_admin(conn)
            assert resolved.email == SUPER_ADMIN_EMAIL
            assert str(resolved.id) == ids["super_admin"]
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_resolve_super_admin_aborts_when_missing(test_db, module):
    sqlalchemy_url, asyncpg_dsn = test_db
    await seed_fixture_data(asyncpg_dsn)
    conn_raw = await asyncpg.connect(asyncpg_dsn)
    try:
        await conn_raw.execute("DELETE FROM users WHERE email = $1", SUPER_ADMIN_EMAIL)
    finally:
        await conn_raw.close()

    engine = create_async_engine(sqlalchemy_url)
    try:
        async with engine.connect() as conn:
            with pytest.raises(module.AbortReset):
                await module._resolve_super_admin(conn)
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_verification_failure_causes_rollback(test_db, module):
    """Simulates a failed post-delete check (mismatched priorities snapshot)
    and confirms the surrounding engine.begin() block rolls back the
    deletions that already ran inside it — the same mechanism run_execute()
    relies on for real."""
    sqlalchemy_url, asyncpg_dsn = test_db
    ids = await seed_fixture_data(asyncpg_dsn)
    before = await counts(asyncpg_dsn, ALL_TABLES)

    engine = create_async_engine(sqlalchemy_url)
    try:
        super_admin = module.SuperAdmin(id=uuid.UUID(ids["super_admin"]), email=SUPER_ADMIN_EMAIL)
        bogus_priorities_before = [
            module.PriorityRow(id=uuid.uuid4(), name="nonexistent", label="X", is_active=True)
        ]
        with pytest.raises(module.AbortReset):
            async with engine.begin() as conn:
                await module._run_deletion_sequence(conn, super_admin)
                await module._verify_after_state(conn, super_admin, bogus_priorities_before)
    finally:
        await engine.dispose()

    after = await counts(asyncpg_dsn, ALL_TABLES)
    assert before == after, "a failed verification must roll back every deletion in the same transaction"


@pytest.mark.asyncio
async def test_verification_passes_for_a_correct_reset(test_db, module):
    sqlalchemy_url, asyncpg_dsn = test_db
    ids = await seed_fixture_data(asyncpg_dsn)

    engine = create_async_engine(sqlalchemy_url)
    try:
        async with engine.connect() as ro_conn:
            super_admin = await module._resolve_super_admin(ro_conn)
            priorities_before = await module._snapshot_priorities(ro_conn)

        async with engine.begin() as conn:
            await module._run_deletion_sequence(conn, super_admin)
            await module._verify_after_state(conn, super_admin, priorities_before)
    finally:
        await engine.dispose()

    after = await counts(asyncpg_dsn, ALL_TABLES)
    assert after["users"] == 1
    assert after["roles"] == 1
    assert after["file_priorities"] == 3
    assert after["otps"] == 1


def test_upload_dir_guard_rejects_dangerous_paths(module, monkeypatch):
    monkeypatch.setattr(module.settings, "UPLOAD_DIR", "/tmp")
    with pytest.raises(module.AbortReset):
        module.resolve_upload_dir()


def test_upload_dir_guard_requires_uploads_basename(module, monkeypatch, tmp_path):
    weird = tmp_path / "not_uploads"
    weird.mkdir()
    monkeypatch.setattr(module.settings, "UPLOAD_DIR", str(weird))
    with pytest.raises(module.AbortReset):
        module.resolve_upload_dir()


def test_upload_dir_guard_accepts_valid_uploads_dir(module, monkeypatch, upload_dir):
    monkeypatch.setattr(module.settings, "UPLOAD_DIR", str(upload_dir))
    resolved = module.resolve_upload_dir()
    assert resolved == upload_dir.resolve()


def test_clean_upload_dir_removes_contents_keeps_directory(module, upload_dir):
    removed = module.clean_upload_dir(upload_dir)
    assert removed == 1
    assert upload_dir.is_dir()
    assert list(upload_dir.iterdir()) == []
