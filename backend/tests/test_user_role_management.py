"""Tests for the User Management + Role Management feature:
  1. User deletion removed (deactivation is the only lifecycle-end action).
  2. All/Active/Inactive status filter on GET /auth/admin/users.
  3. Role Management (list/create/edit/delete), SUPER_ADMIN-only, with
     assigned-role deletion protection and system-role protection.
  4. Bulk-upload temporary-password handling (generated passwords returned,
     never persisted in plaintext).
  5. Optional middle_name across create/edit/bulk-upload/full_name.
"""
import pytest
from sqlalchemy import select, delete as sa_delete

from app.core.security import verify_password
from app.models.user import SystemRole, User, UserRole
from tests.conftest import auth_headers


async def _delete_user_by_email(db, email: str) -> User | None:
    """Cleanup helper for users created indirectly (bulk upload / create
    endpoint) rather than via the `users` fixture's UserFactory."""
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user:
        await db.execute(sa_delete(UserRole).where(UserRole.user_id == user.id))
        await db.execute(sa_delete(User).where(User.id == user.id))
        await db.commit()
    return user


async def _delete_user_by_id(db, user_id) -> None:
    await db.execute(sa_delete(UserRole).where(UserRole.user_id == user_id))
    await db.execute(sa_delete(User).where(User.id == user_id))
    await db.commit()


# ── USER MANAGEMENT: deletion removed ────────────────────────────────────────

@pytest.mark.asyncio
async def test_delete_user_endpoint_no_longer_available(client, users):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    target = await users.make(SystemRole.EFMS_OFFICER)
    r = await client.delete(f"/auth/admin/users/{target.id}", headers=auth_headers(super_admin))
    assert r.status_code in (404, 405)


@pytest.mark.asyncio
async def test_super_admin_cannot_delete_a_user_even_via_direct_call(client, users, db):
    """Confirms the removal is real (not just hidden) — the row still
    exists afterward regardless of the response status."""
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    target = await users.make(SystemRole.EFMS_OFFICER)
    await client.delete(f"/auth/admin/users/{target.id}", headers=auth_headers(super_admin))
    result = await db.execute(select(User).where(User.id == target.id))
    assert result.scalar_one_or_none() is not None


# ── USER MANAGEMENT: status filter ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_status_filter_active_returns_only_active(client, users):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    active_user = await users.make(SystemRole.EFMS_OFFICER, first_name="ActiveFilterUser")
    inactive_user = await users.make(SystemRole.EFMS_OFFICER, first_name="InactiveFilterUser", is_active=False)

    r = await client.get("/auth/admin/users?status=active", headers=auth_headers(super_admin))
    assert r.status_code == 200
    ids = {u["id"] for u in r.json()}
    assert str(active_user.id) in ids
    assert str(inactive_user.id) not in ids


@pytest.mark.asyncio
async def test_status_filter_inactive_returns_only_inactive(client, users):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    active_user = await users.make(SystemRole.EFMS_OFFICER, first_name="ActiveFilterUser2")
    inactive_user = await users.make(SystemRole.EFMS_OFFICER, first_name="InactiveFilterUser2", is_active=False)

    r = await client.get("/auth/admin/users?status=inactive", headers=auth_headers(super_admin))
    assert r.status_code == 200
    ids = {u["id"] for u in r.json()}
    assert str(inactive_user.id) in ids
    assert str(active_user.id) not in ids


@pytest.mark.asyncio
async def test_status_filter_all_returns_both(client, users):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    active_user = await users.make(SystemRole.EFMS_OFFICER, first_name="ActiveFilterUser3")
    inactive_user = await users.make(SystemRole.EFMS_OFFICER, first_name="InactiveFilterUser3", is_active=False)

    r = await client.get("/auth/admin/users?status=all", headers=auth_headers(super_admin))
    assert r.status_code == 200
    ids = {u["id"] for u in r.json()}
    assert str(active_user.id) in ids
    assert str(inactive_user.id) in ids

    # default (no query param) behaves like "all"
    r = await client.get("/auth/admin/users", headers=auth_headers(super_admin))
    ids = {u["id"] for u in r.json()}
    assert str(active_user.id) in ids
    assert str(inactive_user.id) in ids


# ── ROLE MANAGEMENT ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_super_admin_can_list_roles(client, users):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    r = await client.get("/auth/admin/roles", headers=auth_headers(super_admin))
    assert r.status_code == 200
    names = {row["name"] for row in r.json()}
    assert "super_admin" in names
    assert "efms_officer" in names


@pytest.mark.asyncio
async def test_super_admin_can_create_role(client, users, roles):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    r = await client.post(
        "/auth/admin/roles",
        json={"name": "test_records_clerk", "description": "Handles records"},
        headers=auth_headers(super_admin),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "test_records_clerk"
    assert body["is_system"] is False
    assert body["user_count"] == 0
    # Track for cleanup by registering directly via the roles factory's db session.
    from app.models.user import Role as RoleModel
    role_row = await roles._db.get(RoleModel, body["id"])
    roles._created.append(role_row)


@pytest.mark.asyncio
async def test_duplicate_role_creation_is_rejected(client, users, roles):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    role = await roles.make("test_dup_role")
    r = await client.post("/auth/admin/roles", json={"name": role.name}, headers=auth_headers(super_admin))
    assert r.status_code == 409
    # Case-insensitive duplicate too.
    r = await client.post("/auth/admin/roles", json={"name": role.name.upper()}, headers=auth_headers(super_admin))
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_super_admin_can_edit_role(client, users, roles):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    role = await roles.make("test_edit_role", description="Old description")
    r = await client.patch(
        f"/auth/admin/roles/{role.id}",
        json={"description": "New description"},
        headers=auth_headers(super_admin),
    )
    assert r.status_code == 200
    assert r.json()["description"] == "New description"
    assert r.json()["name"] == "test_edit_role"


@pytest.mark.asyncio
async def test_super_admin_can_delete_unassigned_role(client, users, roles):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    role = await roles.make("test_unassigned_role")
    r = await client.delete(f"/auth/admin/roles/{role.id}", headers=auth_headers(super_admin))
    assert r.status_code == 204
    roles._created.remove(role)  # already deleted — don't try again in teardown


@pytest.mark.asyncio
async def test_deleting_assigned_role_returns_correct_error(client, users, roles):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    role = await roles.make("test_assigned_role")
    member = await users.make(role.name)  # type: ignore[arg-type]  (accepts any str role name)
    r = await client.delete(f"/auth/admin/roles/{role.id}", headers=auth_headers(super_admin))
    assert r.status_code == 409
    assert "1 user" in r.json()["detail"]
    # Role must still exist afterward.
    r = await client.get("/auth/admin/roles", headers=auth_headers(super_admin))
    assert any(row["id"] == str(role.id) for row in r.json())


@pytest.mark.asyncio
async def test_normal_user_cannot_access_role_management_endpoints(client, users, roles):
    normal_user = await users.make(SystemRole.EFMS_ADMIN)  # formerly-privileged role, no longer special
    role = await roles.make("test_forbidden_access_role")

    r = await client.get("/auth/admin/roles", headers=auth_headers(normal_user))
    assert r.status_code == 403
    r = await client.post("/auth/admin/roles", json={"name": "should_not_exist"}, headers=auth_headers(normal_user))
    assert r.status_code == 403
    r = await client.patch(f"/auth/admin/roles/{role.id}", json={"description": "x"}, headers=auth_headers(normal_user))
    assert r.status_code == 403
    r = await client.delete(f"/auth/admin/roles/{role.id}", headers=auth_headers(normal_user))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_newly_created_role_does_not_receive_super_admin_privileges(client, users, roles, db):
    """The core security invariant: creating a Role row can never grant the
    SUPER_ADMIN file/system bypass — only an active_role of literally
    'super_admin' can."""
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    role = await roles.make("test_privilege_check_role")
    member = await users.make(role.name)  # type: ignore[arg-type]

    await db.refresh(member)
    assert member.is_super_admin is False

    # Cannot reach a SUPER_ADMIN-gated endpoint.
    r = await client.get("/auth/admin/roles", headers=auth_headers(member))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_super_admin_role_remains_protected(client, users):
    """SUPER_ADMIN cannot be renamed or deleted — see Role.is_system and the
    update_role/delete_role docstrings in app/api/v1/endpoints/auth.py,
    which document this as an explicit, intentional architectural rule."""
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    r = await client.get("/auth/admin/roles", headers=auth_headers(super_admin))
    role_row = next(row for row in r.json() if row["name"] == "super_admin")
    assert role_row["is_system"] is True

    r = await client.patch(f"/auth/admin/roles/{role_row['id']}", json={"name": "mega_admin"}, headers=auth_headers(super_admin))
    assert r.status_code == 400

    r = await client.delete(f"/auth/admin/roles/{role_row['id']}", headers=auth_headers(super_admin))
    assert r.status_code == 400

    # Still there and unchanged afterward.
    r = await client.get("/auth/admin/roles", headers=auth_headers(super_admin))
    assert any(row["name"] == "super_admin" for row in r.json())


@pytest.mark.asyncio
async def test_legacy_development_roles_are_not_permanently_protected(client, users):
    """The 12 roles this app shipped with are development/test data, not
    AVFU's real organizational roles — only super_admin is protected from
    rename/delete. Confirms none of the other 11 carry is_system=True (the
    correction from treating all 12 as permanent "system" roles)."""
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    r = await client.get("/auth/admin/roles", headers=auth_headers(super_admin))
    rows = {row["name"]: row["is_system"] for row in r.json()}
    assert rows["super_admin"] is True
    for legacy_name in ("admin", "hod", "faculty", "efms_officer", "efms_admin", "registrar", "dispatch_officer"):
        assert rows[legacy_name] is False, f"{legacy_name} should not be permanently protected"


@pytest.mark.asyncio
async def test_all_legacy_roles_are_assignable_no_deny_list(client, users, db):
    """Corrected requirement: the 12 original roles (including the 4
    academic-flavored ones like "student") are development/test data, not
    a permanent AVFU organizational structure — none of them are
    special-cased or excluded from eFMS user creation any more than a
    brand-new custom role would be."""
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    email = f"legacy.role.assignable.{super_admin.id.hex[:8]}@example.com"
    r = await client.post(
        "/auth/admin/users",
        json={
            "first_name": "Legacy", "last_name": "RoleUser", "email": email,
            "mobile": "9000000099", "designation": "Student", "role": "student", "temp_password": "Abcdefg1!",
        },
        headers=auth_headers(super_admin),
    )
    assert r.status_code == 201, r.text
    assert r.json()["active_role"] == "student"
    await _delete_user_by_id(db, r.json()["id"])


# ── BULK UPLOAD ────────────────────────────────────────────────────────────────

def _csv_bytes(rows: list[dict], columns: list[str]) -> bytes:
    lines = [",".join(columns)]
    for row in rows:
        lines.append(",".join(row.get(c, "") for c in columns))
    return ("\n".join(lines)).encode("utf-8")


_BULK_COLUMNS = [
    "first_name", "middle_name", "last_name", "email", "mobile", "employee_code",
    "date_of_birth", "designation", "establishment_id", "department_id",
    "role", "is_active", "temp_password",
]


@pytest.mark.asyncio
async def test_bulk_upload_blank_temp_password_creates_users(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    email = f"bulk.blankpw.{super_admin.id.hex[:8]}@example.com"
    csv_bytes = _csv_bytes(
        [{"first_name": "Bulk", "last_name": "User", "email": email, "mobile": "9000000001", "designation": "Clerk", "role": "efms_officer"}],
        _BULK_COLUMNS,
    )
    r = await client.post(
        "/auth/admin/users/bulk",
        files={"file": ("users.csv", csv_bytes, "text/csv")},
        headers=auth_headers(super_admin),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["created"] == 1
    created_user = await _delete_user_by_email(db, email)
    assert created_user is not None
    assert created_user.is_active is True


@pytest.mark.asyncio
async def test_bulk_upload_generated_passwords_returned_and_not_persisted_plaintext(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    email = f"bulk.genpw.{super_admin.id.hex[:8]}@example.com"
    csv_bytes = _csv_bytes(
        [{"first_name": "Gen", "last_name": "Pw", "email": email, "mobile": "9000000002", "designation": "Clerk", "role": "efms_officer"}],
        _BULK_COLUMNS,
    )
    r = await client.post(
        "/auth/admin/users/bulk",
        files={"file": ("users.csv", csv_bytes, "text/csv")},
        headers=auth_headers(super_admin),
    )
    row = r.json()["results"][0]
    assert row["status"] == "created"
    assert row["temp_password"]
    assert row["password_generated"] is True
    plaintext_password = row["temp_password"]

    created_user = await _delete_user_by_email(db, email)
    assert created_user is not None
    # Never stored in plaintext: the hashed column must not equal it, and
    # must NOT even contain it as a substring.
    assert created_user.hashed_password != plaintext_password
    assert plaintext_password not in created_user.hashed_password
    # But it must actually be the real password (hash verifies).
    assert verify_password(plaintext_password, created_user.hashed_password) is True


@pytest.mark.asyncio
async def test_bulk_upload_failed_rows_do_not_expose_passwords(client, users):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    csv_bytes = _csv_bytes(
        [{"first_name": "Bad", "last_name": "Row", "email": "not-an-email", "mobile": "9000000003", "designation": "Clerk", "role": "efms_officer"}],
        _BULK_COLUMNS,
    )
    r = await client.post(
        "/auth/admin/users/bulk",
        files={"file": ("users.csv", csv_bytes, "text/csv")},
        headers=auth_headers(super_admin),
    )
    row = r.json()["results"][0]
    assert row["status"] == "failed"
    assert row["temp_password"] is None
    assert row["error"]


@pytest.mark.asyncio
async def test_bulk_upload_user_supplied_temp_password_behaves_as_before(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    email = f"bulk.suppliedpw.{super_admin.id.hex[:8]}@example.com"
    csv_bytes = _csv_bytes(
        [{"first_name": "Supplied", "last_name": "Pw", "email": email, "mobile": "9000000004",
          "designation": "Clerk", "role": "efms_officer", "temp_password": "Suppl1ed$Pw"}],
        _BULK_COLUMNS,
    )
    r = await client.post(
        "/auth/admin/users/bulk",
        files={"file": ("users.csv", csv_bytes, "text/csv")},
        headers=auth_headers(super_admin),
    )
    row = r.json()["results"][0]
    assert row["status"] == "created"
    assert row["temp_password"] == "Suppl1ed$Pw"
    assert row["password_generated"] is False

    created_user = await _delete_user_by_email(db, email)
    assert created_user is not None
    assert verify_password("Suppl1ed$Pw", created_user.hashed_password) is True


@pytest.mark.asyncio
async def test_bulk_upload_response_requires_super_admin(client, users):
    normal_user = await users.make(SystemRole.EFMS_ADMIN)
    csv_bytes = _csv_bytes([], _BULK_COLUMNS)
    r = await client.post(
        "/auth/admin/users/bulk",
        files={"file": ("users.csv", csv_bytes, "text/csv")},
        headers=auth_headers(normal_user),
    )
    assert r.status_code == 403


# ── MIDDLE NAME ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_user_can_be_created_with_middle_name(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    email = f"middlename.with.{super_admin.id.hex[:8]}@example.com"
    r = await client.post(
        "/auth/admin/users",
        json={
            "first_name": "Anand", "middle_name": "Kumar", "last_name": "Rao", "email": email,
            "mobile": "9000000005", "designation": "Officer", "role": "efms_officer", "temp_password": "Abcdefg1!",
        },
        headers=auth_headers(super_admin),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["middle_name"] == "Kumar"
    assert body["full_name"] == "Anand Kumar Rao"

    await _delete_user_by_id(db, body["id"])


@pytest.mark.asyncio
async def test_user_can_be_created_without_middle_name(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    email = f"middlename.without.{super_admin.id.hex[:8]}@example.com"
    r = await client.post(
        "/auth/admin/users",
        json={
            "first_name": "Anand", "last_name": "Rao", "email": email,
            "mobile": "9000000006", "designation": "Officer", "role": "efms_officer", "temp_password": "Abcdefg1!",
        },
        headers=auth_headers(super_admin),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["middle_name"] is None
    assert body["full_name"] == "Anand Rao"
    assert "  " not in body["full_name"]  # no double space

    await _delete_user_by_id(db, body["id"])


@pytest.mark.asyncio
async def test_middle_name_preserved_on_edit(client, users):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    target = await users.make(SystemRole.EFMS_OFFICER, first_name="Edit", last_name="Target")

    r = await client.patch(
        f"/auth/admin/users/{target.id}",
        json={"middle_name": "Newmiddle"},
        headers=auth_headers(super_admin),
    )
    assert r.status_code == 200
    assert r.json()["middle_name"] == "Newmiddle"
    assert r.json()["full_name"] == "Edit Newmiddle Target"

    # Editing an unrelated field afterward must not drop the middle name.
    r = await client.patch(
        f"/auth/admin/users/{target.id}",
        json={"designation": "Senior Officer"},
        headers=auth_headers(super_admin),
    )
    assert r.status_code == 200
    assert r.json()["middle_name"] == "Newmiddle"


@pytest.mark.asyncio
async def test_csv_import_accepts_middle_name(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    email = f"csv.middlename.{super_admin.id.hex[:8]}@example.com"
    csv_bytes = _csv_bytes(
        [{"first_name": "Csv", "middle_name": "Middle", "last_name": "Row", "email": email,
          "mobile": "9000000007", "designation": "Clerk", "role": "efms_officer"}],
        _BULK_COLUMNS,
    )
    r = await client.post(
        "/auth/admin/users/bulk",
        files={"file": ("users.csv", csv_bytes, "text/csv")},
        headers=auth_headers(super_admin),
    )
    row = r.json()["results"][0]
    assert row["status"] == "created"
    assert row["full_name"] == "Csv Middle Row"

    created_user = await _delete_user_by_email(db, email)
    assert created_user is not None
    assert created_user.middle_name == "Middle"
    assert created_user.full_name == "Csv Middle Row"


@pytest.mark.asyncio
async def test_existing_user_with_null_middle_name_continues_to_work(client, users):
    """Users created before this feature (middle_name always NULL) must
    still authenticate and render correctly."""
    user = await users.make(SystemRole.EFMS_OFFICER, first_name="Legacy", last_name="User")
    assert user.middle_name is None

    r = await client.get("/auth/me", headers=auth_headers(user))
    assert r.status_code == 200
    body = r.json()
    assert body["full_name"] == "Legacy User"
    assert "  " not in body["full_name"]


@pytest.mark.asyncio
async def test_full_name_formatting_with_and_without_middle_name(users):
    with_middle = await users.make(SystemRole.EFMS_OFFICER, first_name="A", last_name="C")
    with_middle.middle_name = "B"
    assert with_middle.full_name == "A B C"

    without_middle = await users.make(SystemRole.EFMS_OFFICER, first_name="A", last_name="C")
    assert without_middle.full_name == "A C"
    assert "  " not in without_middle.full_name


# ── NORMAL eFMS WORKFLOW: role name carries no privilege ────────────────────
# Dispatch is the normal file-forwarding/routing workflow, not a privileged
# function. These tests confirm that (a) creating/holding/forwarding files
# works identically for a legacy role, a genuinely arbitrary custom role,
# and that (b) dispatch_file/list_dispatches no longer require any specific
# role — only the current-holder relationship, exactly like every other
# file-mutating endpoint in efms_files.py.

async def _create_file_as(client, creator) -> str:
    r = await client.post(
        "/efms/files",
        json={"subject": "Normal workflow test file", "category": "general", "initial_content": "content"},
        headers=auth_headers(creator),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _delete_file(db, file_id):
    from app.models.efms import EfmsFile, DispatchRecord
    # DispatchRecord.file_id has no cascade/ondelete (not nullable), so it
    # must be removed explicitly before the parent file — unlike
    # notesheet/holder_notes/route_entries/attachments, which the ORM
    # relationship already cascades on file deletion.
    await db.execute(sa_delete(DispatchRecord).where(DispatchRecord.file_id == file_id))
    f = await db.get(EfmsFile, file_id)
    if f:
        await db.delete(f)
        await db.commit()


@pytest.mark.parametrize("role_name", ["hod", "faculty", "registrar", "dispatch_officer", "efms_admin"])
@pytest.mark.asyncio
async def test_legacy_role_user_can_create_hold_forward(client, users, db, role_name):
    creator = await users.make(role_name, first_name="LegacyCreator")
    recipient = await users.make(role_name, first_name="LegacyRecipient")
    file_id = await _create_file_as(client, creator)
    try:
        # Hold: creator is current holder of their own new Draft.
        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(creator))
        assert r.status_code == 200
        assert r.json()["current_holder_id"] == str(creator.id)

        # Forward: normal route_file action, authorized purely by
        # current-holder relationship — no role check anywhere in this path.
        r = await client.post(
            f"/efms/files/{file_id}/route",
            json={"action": "forward", "to_user_id": str(recipient.id), "remarks": "fwd"},
            headers=auth_headers(creator),
        )
        assert r.status_code == 200
        assert r.json()["current_holder_id"] == str(recipient.id)
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_custom_role_user_can_create_hold_forward_without_hardcoded_list(client, users, roles, db):
    """A brand-new role Super Admin just created, with a name that has
    never appeared in any hard-coded list anywhere in the application."""
    role = await roles.make("test_records_clerk_workflow")
    creator = await users.make(role.name, first_name="CustomRoleCreator")  # type: ignore[arg-type]
    recipient = await users.make(role.name, first_name="CustomRoleRecipient")  # type: ignore[arg-type]
    file_id = await _create_file_as(client, creator)
    try:
        r = await client.post(
            f"/efms/files/{file_id}/route",
            json={"action": "forward", "to_user_id": str(recipient.id), "remarks": "fwd"},
            headers=auth_headers(creator),
        )
        assert r.status_code == 200
        assert r.json()["current_holder_id"] == str(recipient.id)

        # The new holder can now open the file and act on it in turn.
        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(recipient))
        assert r.status_code == 200
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_dispatch_does_not_require_dispatch_officer_role(client, users, db):
    """The core correction this task makes: dispatch_file used to require
    role in {dispatch_officer, efms_admin, registrar}. It must now work for
    the current holder regardless of role name."""
    holder = await users.make("test_arbitrary_role_for_dispatch")
    file_id = await _create_file_as(client, holder)
    try:
        r = await client.post(
            f"/efms/dispatch/{file_id}",
            json={"mode": "postal", "recipient": "External Office", "address": "123 Main St"},
            headers=auth_headers(holder),
        )
        assert r.status_code == 201, r.text
        assert r.json()["mode"] == "postal"

        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(holder))
        assert r.json()["status"] == "dispatched"
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_dispatch_still_requires_current_holder(client, users, db):
    """Removing the role gate must not remove authorization entirely —
    only the current holder (or SUPER_ADMIN) may dispatch a file."""
    holder = await users.make("test_holder_role_for_dispatch_auth")
    outsider = await users.make("test_outsider_role_for_dispatch_auth")
    file_id = await _create_file_as(client, holder)
    try:
        r = await client.post(
            f"/efms/dispatch/{file_id}",
            json={"mode": "postal", "recipient": "External Office"},
            headers=auth_headers(outsider),
        )
        assert r.status_code == 403
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_super_admin_can_dispatch_any_file(client, users, db):
    holder = await users.make("test_holder_role_for_super_admin_dispatch")
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    file_id = await _create_file_as(client, holder)
    try:
        r = await client.post(
            f"/efms/dispatch/{file_id}",
            json={"mode": "internal", "recipient": "Internal Office"},
            headers=auth_headers(super_admin),
        )
        assert r.status_code == 201, r.text
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_list_dispatches_does_not_require_special_role(client, users):
    """Any authenticated eFMS user may view the dispatch log — no role
    restriction, matching list_files/search_files elsewhere."""
    normal_user = await users.make("test_arbitrary_role_for_list_dispatches")
    r = await client.get("/efms/dispatch", headers=auth_headers(normal_user))
    assert r.status_code == 200
