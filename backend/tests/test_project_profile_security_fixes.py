"""Regression tests for the three post-implementation security/correctness
fixes applied to the Project-Specific User Profiles feature:

  1. Forgot Password can no longer reach or affect a project profile
     (forgot_password / forgot_password_verify / forgot_password_reset).
  2. route_file's forward branch now rejects an inactive recipient
     (project profile or ordinary user), not just a Super Admin one.
  3. The generic User Management endpoints (PATCH /auth/admin/users/{uid}
     and .../status) now reject project-profile rows outright — project
     profiles remain manageable only through Project Management.
"""
import pytest
from sqlalchemy import select, delete as sa_delete, update as sa_update

from app.models.efms import EfmsFile, DispatchRecord
from app.models.efms_extra import OTP
from app.models.project import Project
from app.models.user import User, SystemRole
from tests.conftest import auth_headers

_NEW_PASSWORD = "NewPassw0rd!"


# ── Local helpers (mirrors tests/test_project_profiles.py's own) ────────────

async def _delete_file(db, file_id):
    await db.execute(sa_delete(DispatchRecord).where(DispatchRecord.file_id == file_id))
    f = await db.get(EfmsFile, file_id)
    if f:
        await db.delete(f)
        await db.commit()


async def _delete_project(db, project_id):
    await db.execute(sa_update(Project).where(Project.id == project_id).values(current_profile_id=None))
    result = await db.execute(select(User.id).where(User.project_id == project_id))
    profile_ids = [row[0] for row in result.all()]
    if profile_ids:
        await db.execute(sa_delete(User).where(User.id.in_(profile_ids)))
    await db.execute(sa_delete(Project).where(Project.id == project_id))
    await db.commit()


async def _delete_otps(db, email: str) -> None:
    await db.execute(sa_delete(OTP).where(OTP.target == email))
    await db.commit()


async def _latest_otp(db, email: str, otp_type: str):
    r = await db.execute(
        select(OTP).where(OTP.target == email, OTP.otp_type == otp_type).order_by(OTP.created_at.desc()).limit(1)
    )
    return r.scalar_one_or_none()


async def _create_project(client, super_admin, name="Security Fix Test Project"):
    r = await client.post("/projects", json={"name": name}, headers=auth_headers(super_admin))
    assert r.status_code == 201, r.text
    return r.json()


async def _assign(client, super_admin, project_id, user_id):
    r = await client.post(f"/projects/{project_id}/assign", json={"user_id": str(user_id)}, headers=auth_headers(super_admin))
    assert r.status_code == 200, r.text
    return r.json()


# ══════════════════════════════════════════════════════════════════════════
# FIX 1 — Forgot Password must never touch a project profile
# ══════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_ordinary_user_forgot_password_still_works(client, users, db):
    """Regression: normal Forgot Password behavior for a real person must
    be completely unaffected by the project-profile guard."""
    user = await users.make(SystemRole.EFMS_OFFICER, first_name="Ordinary")
    try:
        r = await client.post("/auth/forgot-password", json={"email": user.email})
        assert r.status_code == 200
        otp = await _latest_otp(db, user.email, "password_reset")
        assert otp is not None and otp.is_used is False

        verify = await client.post("/auth/forgot-password/verify", json={"email": user.email, "otp": otp.code})
        assert verify.status_code == 200
        reset_token = verify.json()["reset_token"]

        reset = await client.post("/auth/forgot-password/reset", json={
            "reset_token": reset_token, "new_password": _NEW_PASSWORD, "confirm_password": _NEW_PASSWORD,
        })
        assert reset.status_code == 200
        await db.refresh(user)
        from app.core.security import verify_password
        assert verify_password(_NEW_PASSWORD, user.hashed_password)
    finally:
        await _delete_otps(db, user.email)


@pytest.mark.asyncio
async def test_project_profile_cannot_initiate_password_reset(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        profile = await db.get(User, result["current_profile_id"])

        r = await client.post("/auth/forgot-password", json={"email": profile.email})
        assert r.status_code == 200  # same generic response — no enumeration signal
        otp = await _latest_otp(db, profile.email, "password_reset")
        assert otp is None  # no OTP was ever created for the project profile
    finally:
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_forgot_password_response_identical_for_project_profile_and_unknown_email(client, users, db):
    """No enumeration signal: a project profile's email must produce the
    exact same response as a wrong password / unknown email would."""
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        profile = await db.get(User, result["current_profile_id"])

        r1 = await client.post("/auth/forgot-password", json={"email": profile.email})
        r2 = await client.post("/auth/forgot-password", json={"email": "definitely.nobody@example.com"})
        assert r1.status_code == r2.status_code == 200
        assert r1.json() == r2.json()
    finally:
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_project_profile_cannot_obtain_reset_token_even_with_a_manually_created_otp(client, users, db):
    """Defense-in-depth: even if an OTP row somehow existed for a project
    profile (bypassing step 1 entirely), /forgot-password/verify must still
    refuse to mint a reset_token for it."""
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        profile = await db.get(User, result["current_profile_id"])

        from app.utils.otp import create_otp as otp_create
        code = await otp_create(db, profile.email, "password_reset")
        await db.commit()

        r = await client.post("/auth/forgot-password/verify", json={"email": profile.email, "otp": code})
        assert r.status_code == 400
    finally:
        await _delete_otps(db, profile.email)
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_project_profile_reset_endpoint_rejects_even_with_a_forged_token(client, users, db):
    """Defense-in-depth: even a validly-signed password_reset token minted
    directly (bypassing steps 1-2 entirely) for a project profile must be
    rejected by /forgot-password/reset before it ever sets hashed_password."""
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        profile = await db.get(User, result["current_profile_id"])

        import hashlib
        from app.core.security import create_password_reset_token
        pwd_sig = hashlib.sha256((profile.hashed_password or "").encode()).hexdigest()
        forged_token = create_password_reset_token(subject=str(profile.id), extra_claims={"pwd_sig": pwd_sig})

        r = await client.post("/auth/forgot-password/reset", json={
            "reset_token": forged_token, "new_password": _NEW_PASSWORD, "confirm_password": _NEW_PASSWORD,
        })
        assert r.status_code == 400

        await db.refresh(profile)
        assert profile.hashed_password is None  # still passwordless
    finally:
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_project_profile_change_password_still_rejected(client, users, db):
    """Regression: the authenticated Change Password endpoint must remain
    unusable for a project profile (it has no current password to verify)."""
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        switched = await client.post("/auth/switch-profile", json={"profile_user_id": result["current_profile_id"]}, headers=auth_headers(origin))
        profile_headers = {"Authorization": f"Bearer {switched.json()['access_token']}"}

        r = await client.post("/auth/change-password", json={
            "current_password": "anything", "new_password": _NEW_PASSWORD, "confirm_password": _NEW_PASSWORD,
        }, headers=profile_headers)
        assert r.status_code == 401
    finally:
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_project_profile_login_step1_still_rejected(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        profile = await db.get(User, result["current_profile_id"])
        r = await client.post("/auth/login/step1", json={"email": profile.email, "password": "anything"})
        assert r.status_code == 401
    finally:
        await _delete_project(db, project["id"])


# ══════════════════════════════════════════════════════════════════════════
# FIX 2 — route_file must reject an inactive recipient
# ══════════════════════════════════════════════════════════════════════════

async def _create_file(client, creator, subject="Inactive recipient test"):
    r = await client.post("/efms/files", json={
        "subject": subject, "category": "general", "initial_content": "<p>content</p>",
    }, headers=auth_headers(creator))
    assert r.status_code == 201, r.text
    return r.json()["id"]


@pytest.mark.asyncio
async def test_active_ordinary_user_can_still_receive_forward(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    recipient = await users.make(SystemRole.EFMS_OFFICER, first_name="Recipient")
    file_id = await _create_file(client, creator)
    try:
        r = await client.post(f"/efms/files/{file_id}/route", json={"action": "forward", "to_user_id": str(recipient.id)}, headers=auth_headers(creator))
        assert r.status_code == 200, r.text
        assert r.json()["current_holder_id"] == str(recipient.id)
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_inactive_ordinary_user_cannot_receive_forward(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    recipient = await users.make(SystemRole.EFMS_OFFICER, first_name="Recipient", is_active=False)
    file_id = await _create_file(client, creator)
    try:
        r = await client.post(f"/efms/files/{file_id}/route", json={"action": "forward", "to_user_id": str(recipient.id)}, headers=auth_headers(creator))
        assert r.status_code == 400
        assert "inactive" in r.json()["detail"].lower()

        # File must not have moved.
        check = await client.get(f"/efms/files/{file_id}", headers=auth_headers(creator))
        assert check.json()["current_holder_id"] == str(creator.id)
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_active_project_profile_can_receive_forward(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    project = await _create_project(client, super_admin)
    file_id = None
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        file_id = await _create_file(client, creator)
        r = await client.post(f"/efms/files/{file_id}/route", json={"action": "forward", "to_user_id": result["current_profile_id"]}, headers=auth_headers(creator))
        assert r.status_code == 200, r.text
        assert r.json()["current_holder_id"] == result["current_profile_id"]
    finally:
        if file_id:
            await _delete_file(db, file_id)
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_completed_project_profile_cannot_receive_forward_directly(client, users, db):
    """The core Fix 2 scenario: a direct API request naming a completed
    project profile as recipient must be rejected, not just hidden from the
    recipient picker."""
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    project = await _create_project(client, super_admin)
    file_id = None
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        await client.patch(f"/projects/{project['id']}/complete", headers=auth_headers(super_admin))

        file_id = await _create_file(client, creator)
        r = await client.post(f"/efms/files/{file_id}/route", json={"action": "forward", "to_user_id": result["current_profile_id"]}, headers=auth_headers(creator))
        assert r.status_code == 400
        assert "inactive" in r.json()["detail"].lower()

        check = await client.get(f"/efms/files/{file_id}", headers=auth_headers(creator))
        assert check.json()["current_holder_id"] == str(creator.id)
    finally:
        if file_id:
            await _delete_file(db, file_id)
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_super_admin_recipient_restriction_still_enforced(client, users, db):
    """Regression: Fix 2 must not have disturbed the existing Super Admin
    recipient block."""
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    file_id = await _create_file(client, creator)
    try:
        r = await client.post(f"/efms/files/{file_id}/route", json={"action": "forward", "to_user_id": str(super_admin.id)}, headers=auth_headers(creator))
        assert r.status_code == 400
        assert "super admin" in r.json()["detail"].lower()
    finally:
        await _delete_file(db, file_id)


# ══════════════════════════════════════════════════════════════════════════
# FIX 3 — generic User Management endpoints must reject project profiles
# ══════════════════════════════════════════════════════════════════════════

@pytest.mark.asyncio
async def test_generic_status_endpoint_still_works_for_ordinary_user(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    target = await users.make(SystemRole.EFMS_OFFICER, first_name="Target")
    r = await client.patch(f"/auth/admin/users/{target.id}/status", json={
        "is_active": False, "reason_type": "resigned", "remarks": "test",
    }, headers=auth_headers(super_admin))
    assert r.status_code == 200
    assert r.json()["is_active"] is False


@pytest.mark.asyncio
async def test_generic_status_endpoint_rejects_project_profile(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        r = await client.patch(f"/auth/admin/users/{result['current_profile_id']}/status", json={"is_active": True}, headers=auth_headers(super_admin))
        assert r.status_code == 400

        # Also cannot be used to reactivate a completed project's profile.
        await client.patch(f"/projects/{project['id']}/complete", headers=auth_headers(super_admin))
        r = await client.patch(f"/auth/admin/users/{result['current_profile_id']}/status", json={"is_active": True}, headers=auth_headers(super_admin))
        assert r.status_code == 400
        profile = await db.get(User, result["current_profile_id"])
        assert profile.is_active is False  # unchanged — still consistent with the completed project
    finally:
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_generic_edit_endpoint_still_works_for_ordinary_user(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    target = await users.make(SystemRole.EFMS_OFFICER, first_name="Target")
    r = await client.patch(f"/auth/admin/users/{target.id}", json={"designation": "Senior Officer"}, headers=auth_headers(super_admin))
    assert r.status_code == 200
    assert r.json()["designation"] == "Senior Officer"


@pytest.mark.asyncio
async def test_generic_edit_endpoint_rejects_project_profile(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        r = await client.patch(f"/auth/admin/users/{result['current_profile_id']}", json={"designation": "Hacked"}, headers=auth_headers(super_admin))
        assert r.status_code == 400

        profile = await db.get(User, result["current_profile_id"])
        assert profile.designation == origin.designation  # unchanged
    finally:
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_generic_role_change_rejects_project_profile(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        r = await client.patch(f"/auth/admin/users/{result['current_profile_id']}", json={"role": "registrar"}, headers=auth_headers(super_admin))
        assert r.status_code == 400

        profile = await db.get(User, result["current_profile_id"])
        assert profile.active_role == origin.active_role  # unchanged — still inherited
    finally:
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_project_lifecycle_endpoints_still_work_after_guard(client, users, db):
    """Regression: complete/reactivate/reassign (the ONLY sanctioned way to
    manage a project profile's lifecycle) must be completely unaffected by
    the new generic-endpoint guard."""
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    origin2 = await users.make(SystemRole.EFMS_OFFICER, first_name="UserD")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)

        r = await client.patch(f"/projects/{project['id']}/complete", headers=auth_headers(super_admin))
        assert r.status_code == 200 and r.json()["status"] == "completed"
        profile = await db.get(User, result["current_profile_id"])
        assert profile.is_active is False

        r = await client.patch(f"/projects/{project['id']}/reactivate", headers=auth_headers(super_admin))
        assert r.status_code == 200 and r.json()["status"] == "active"
        await db.refresh(profile)
        assert profile.is_active is True

        r = await client.post(f"/projects/{project['id']}/reassign", json={"user_id": str(origin2.id)}, headers=auth_headers(super_admin))
        assert r.status_code == 200
        assert r.json()["current_profile_id"] != result["current_profile_id"]
    finally:
        await _delete_project(db, project["id"])
