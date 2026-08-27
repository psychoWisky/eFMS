"""SUPER_ADMIN-only authorization, user deactivation/reactivation, and
person-display tests for the changes described in this task:

  - _ADMIN_ROLES (EFMS_ADMIN/EFMS_OFFICER/REGISTRAR/ADMIN) no longer bypasses
    file-level authorization; only SUPER_ADMIN does.
  - User.is_active enforcement (unchanged) still blocks login/API access.
  - Deactivation persists reason/remarks/actor/timestamp and cannot be used
    to strand the system without an active Super Admin.
  - PersonInfo/person_info_map expose is_active for historical display.

Uses the real chain from the investigation this task is based on:
Akash -> Deepa -> Rajesh -> Priya, with Akash/Priya = EFMS_OFFICER,
Deepa = EFMS_ADMIN, Rajesh = HOD.
"""
import pytest
from sqlalchemy import select

from app.models.efms import EfmsFile
from app.models.user import SystemRole, User
from app.utils.person_info import person_info_map
from tests.conftest import auth_headers


async def _delete_file(db, file_id):
    f = await db.get(EfmsFile, file_id)
    if f:
        await db.delete(f)
        await db.commit()


async def _build_chain(client, users):
    """Akash creates a file and forwards it Akash -> Deepa -> Rajesh -> Priya,
    each holder saving their own HolderNote while they hold it. Returns
    (file_id, {name: user})."""
    akash = await users.make(SystemRole.EFMS_OFFICER, first_name="Akash", last_name="Ranjan")
    deepa = await users.make(SystemRole.EFMS_ADMIN, first_name="Deepa", last_name="Pillai")
    rajesh = await users.make(SystemRole.HOD, first_name="Rajesh", last_name="Sharma")
    priya = await users.make(SystemRole.EFMS_OFFICER, first_name="Priya", last_name="Nair")

    r = await client.post(
        "/efms/files",
        json={"subject": "Test file for authorization matrix", "category": "general", "initial_content": "original notesheet"},
        headers=auth_headers(akash),
    )
    assert r.status_code == 201, r.text
    file_id = r.json()["id"]

    async def forward(from_user, to_user, remark):
        rr = await client.patch(
            f"/efms/files/{file_id}/holder-notesheet",
            json={"content": f"{from_user.first_name}'s notesheet"},
            headers=auth_headers(from_user),
        )
        assert rr.status_code == 200, rr.text
        rr = await client.post(
            f"/efms/files/{file_id}/route",
            json={"action": "forward", "to_user_id": str(to_user.id), "remarks": remark},
            headers=auth_headers(from_user),
        )
        assert rr.status_code == 200, rr.text

    await forward(akash, deepa, "Please review.")
    await forward(deepa, rajesh, "Forwarding for approval.")
    await forward(rajesh, priya, "Approved, forwarding onward.")
    # Priya (final/current holder) saves her own note too.
    rr = await client.patch(
        f"/efms/files/{file_id}/holder-notesheet",
        json={"content": "Priya's notesheet"},
        headers=auth_headers(priya),
    )
    assert rr.status_code == 200, rr.text

    return file_id, {"akash": akash, "deepa": deepa, "rajesh": rajesh, "priya": priya}


# ── AUTHORIZATION: SUPER_ADMIN-only global bypass ────────────────────────────

@pytest.mark.asyncio
async def test_super_admin_can_access_another_users_file(client, users, db):
    file_id, people = await _build_chain(client, users)
    try:
        super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Super")
        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(super_admin))
        assert r.status_code == 200
    finally:
        await _delete_file(db, file_id)


@pytest.mark.parametrize("role_name", ["EFMS_ADMIN", "EFMS_OFFICER", "REGISTRAR", "HOD"])
@pytest.mark.asyncio
async def test_non_super_admin_roles_cannot_use_global_bypass(client, users, db, role_name):
    """An unrelated user holding one of the formerly-privileged roles must be
    denied access to a file they have no relationship to — this is the core
    regression this task exists to fix."""
    file_id, people = await _build_chain(client, users)
    try:
        role = getattr(SystemRole, role_name)
        outsider = await users.make(role, first_name="Outsider")
        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(outsider))
        assert r.status_code == 403

        r = await client.get(f"/efms/files/{file_id}/holder-notesheets", headers=auth_headers(outsider))
        assert r.status_code == 403
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_unrelated_normal_user_gets_403(client, users, db):
    file_id, people = await _build_chain(client, users)
    try:
        outsider = await users.make(SystemRole.FACULTY, first_name="Outsider")
        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(outsider))
        assert r.status_code == 403
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_legitimate_relationships_still_work(client, users, db):
    """Regression guard: creator/current-holder/uploader access, which was
    NOT supposed to change, must still work exactly as before."""
    file_id, people = await _build_chain(client, users)
    try:
        # Priya is the current holder -> full access.
        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(people["priya"]))
        assert r.status_code == 200

        # Akash is the creator but no longer current holder -> full-open is
        # replaced by the deliberate My Files creator_restricted carve-out
        # (My Files/Direct Forward task, Part 1-3): a 200 with restricted
        # content instead of a 403. Tracking/history access remains
        # available too, exactly as before.
        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(people["akash"]))
        assert r.status_code == 200
        assert r.json()["access_level"] == "creator_restricted"
        r = await client.get(f"/efms/files/{file_id}/track", headers=auth_headers(people["akash"]))
        assert r.status_code == 200

        # The current holder (Priya) has full remark visibility -> sees every
        # holder's HolderNote, exactly as before this task (unchanged rule).
        r = await client.get(f"/efms/files/{file_id}/holder-notesheets", headers=auth_headers(people["priya"]))
        assert r.status_code == 200
        rows = r.json()
        assert {row["user_id"] for row in rows} == {str(u.id) for u in people.values()}

        # A past holder who is no longer current holder can no longer fully
        # open the file at all (existing _assert_full_file_access rule,
        # unchanged by this task) -> 403, not a scoped 200.
        r = await client.get(f"/efms/files/{file_id}/holder-notesheets", headers=auth_headers(people["deepa"]))
        assert r.status_code == 403
    finally:
        await _delete_file(db, file_id)


# ── USER STATUS: authentication enforcement (existing behavior, unchanged) ──

@pytest.mark.asyncio
async def test_active_user_can_authenticate(client, users):
    user = await users.make(SystemRole.EFMS_OFFICER)
    r = await client.get("/auth/me", headers=auth_headers(user))
    assert r.status_code == 200
    assert r.json()["email"] == user.email


@pytest.mark.asyncio
async def test_inactive_user_cannot_authenticate(client, users):
    user = await users.make(SystemRole.EFMS_OFFICER, is_active=False)
    r = await client.get("/auth/me", headers=auth_headers(user))
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_inactive_user_login_step1_rejected(client, users):
    user = await users.make(SystemRole.EFMS_OFFICER, is_active=False)
    r = await client.post("/auth/login/step1", json={"email": user.email, "password": "Pytest@12345"})
    assert r.status_code == 403


# ── SUPER ADMIN: deactivate / reactivate a normal user ───────────────────────

@pytest.mark.asyncio
async def test_super_admin_can_deactivate_and_reactivate_user(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Super")
    target = await users.make(SystemRole.EFMS_OFFICER, first_name="Target")

    r = await client.patch(
        f"/auth/admin/users/{target.id}/status",
        json={"is_active": False, "reason_type": "retired", "remarks": "Retired from service."},
        headers=auth_headers(super_admin),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["is_active"] is False
    assert body["deactivation_reason_type"] == "retired"
    assert body["deactivation_remarks"] == "Retired from service."
    assert body["deactivated_at"] is not None
    assert body["deactivated_by"] == str(super_admin.id)

    # Deactivated user is now locked out.
    r = await client.get("/auth/me", headers=auth_headers(target))
    assert r.status_code == 401

    # Reactivate.
    r = await client.patch(
        f"/auth/admin/users/{target.id}/status",
        json={"is_active": True},
        headers=auth_headers(super_admin),
    )
    assert r.status_code == 200
    assert r.json()["is_active"] is True

    r = await client.get("/auth/me", headers=auth_headers(target))
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_deactivation_requires_a_reason(client, users):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Super")
    target = await users.make(SystemRole.EFMS_OFFICER)
    r = await client.patch(
        f"/auth/admin/users/{target.id}/status",
        json={"is_active": False},
        headers=auth_headers(super_admin),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_non_super_admin_cannot_deactivate_users(client, users):
    """Formerly-privileged EFMS_ADMIN must no longer pass the system-
    administration gate either."""
    efms_admin = await users.make(SystemRole.EFMS_ADMIN)
    target = await users.make(SystemRole.EFMS_OFFICER)
    r = await client.patch(
        f"/auth/admin/users/{target.id}/status",
        json={"is_active": False, "reason_type": "retired"},
        headers=auth_headers(efms_admin),
    )
    assert r.status_code == 403


# ── SUPER ADMIN SAFETY: cannot strand the system without an admin ──────────

@pytest.mark.asyncio
async def test_cannot_deactivate_the_only_active_super_admin(client, users, db):
    # Ensure there is exactly one active Super Admin for the duration of this
    # test by deactivating any that already exist in the (shared, real) DB,
    # then restoring them afterward.
    result = await db.execute(select(User).where(User.active_role == SystemRole.SUPER_ADMIN, User.is_active == True))
    pre_existing = result.scalars().all()
    for u in pre_existing:
        u.is_active = False
    await db.commit()

    try:
        only_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="OnlyAdmin")
        r = await client.patch(
            f"/auth/admin/users/{only_admin.id}/status",
            json={"is_active": False, "reason_type": "other", "remarks": "test"},
            headers=auth_headers(only_admin),
        )
        assert r.status_code == 409
    finally:
        for u in pre_existing:
            u.is_active = True
        await db.commit()


@pytest.mark.asyncio
async def test_cannot_demote_the_only_active_super_admin(client, users, db):
    result = await db.execute(select(User).where(User.active_role == SystemRole.SUPER_ADMIN, User.is_active == True))
    pre_existing = result.scalars().all()
    for u in pre_existing:
        u.is_active = False
    await db.commit()

    try:
        only_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="OnlyAdmin2")
        r = await client.patch(
            f"/auth/admin/users/{only_admin.id}",
            json={"role": "efms_officer"},
            headers=auth_headers(only_admin),
        )
        assert r.status_code == 409
    finally:
        for u in pre_existing:
            u.is_active = True
        await db.commit()


# ── RECIPIENT PICKERS: inactive users excluded, active users selectable ─────

@pytest.mark.asyncio
async def test_inactive_users_excluded_from_recipient_picker(client, users):
    caller = await users.make(SystemRole.EFMS_OFFICER, first_name="Caller")
    active_candidate = await users.make(SystemRole.EFMS_OFFICER, first_name="ActiveCandidate")
    inactive_candidate = await users.make(SystemRole.EFMS_OFFICER, first_name="InactiveCandidate", is_active=False)

    r = await client.get("/admin/users", headers=auth_headers(caller))
    assert r.status_code == 200
    ids = {u["id"] for u in r.json()}
    assert str(active_candidate.id) in ids
    assert str(inactive_candidate.id) not in ids


# ── PERSON DISPLAY: is_active surfaced for historical actors ────────────────

@pytest.mark.asyncio
async def test_person_info_exposes_is_active(db, users):
    active_user = await users.make(SystemRole.EFMS_OFFICER, first_name="ActivePerson")
    inactive_user = await users.make(SystemRole.EFMS_OFFICER, first_name="InactivePerson", is_active=False)

    people = await person_info_map({active_user.id, inactive_user.id}, db)
    assert people[active_user.id].is_active is True
    assert people[inactive_user.id].is_active is False
    # Name must still resolve — never dropped/nulled for an inactive user.
    assert people[inactive_user.id].full_name == inactive_user.full_name


@pytest.mark.asyncio
async def test_historical_file_references_survive_deactivation(client, users, db):
    """Deactivating a past participant must not delete or null out their
    historical route/holder-note references, and the file must still show
    their name (with is_active=False) via *_info payloads."""
    file_id, people = await _build_chain(client, users)
    try:
        super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Super")
        r = await client.patch(
            f"/auth/admin/users/{people['akash'].id}/status",
            json={"is_active": False, "reason_type": "retired"},
            headers=auth_headers(super_admin),
        )
        assert r.status_code == 200

        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(super_admin))
        assert r.status_code == 200
        body = r.json()
        assert body["creator_info"]["full_name"] == people["akash"].full_name
        assert body["creator_info"]["is_active"] is False

        r = await client.get(f"/efms/files/{file_id}/track", headers=auth_headers(super_admin))
        assert r.status_code == 200
        entries = r.json()
        assert len(entries) == 3  # Akash->Deepa, Deepa->Rajesh, Rajesh->Priya all still present
        first = entries[0]
        assert first["from_user_info"]["full_name"] == people["akash"].full_name
        assert first["from_user_info"]["is_active"] is False
    finally:
        await _delete_file(db, file_id)
