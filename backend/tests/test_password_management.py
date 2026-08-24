"""Password management: Forgot Password (unauthenticated, OTP-verified),
Change Password (authenticated, self-service), removal of the Super-Admin
"reset another user's password" endpoint, and first-login temp-password
flow regression checks.
"""
import pytest
from datetime import datetime, timedelta, timezone
from sqlalchemy import select, delete as sa_delete

from app.core.security import verify_password
from app.models.user import SystemRole, User
from app.models.efms_extra import OTP
from tests.conftest import auth_headers

_PASSWORD = "Pytest@12345"  # matches UserFactory.make()'s fixed test password
_NEW_PASSWORD = "NewPassw0rd!"


async def _delete_otps(db, email: str) -> None:
    await db.execute(sa_delete(OTP).where(OTP.target == email))
    await db.commit()


async def _latest_otp(db, email: str, otp_type: str) -> OTP:
    r = await db.execute(
        select(OTP).where(OTP.target == email, OTP.otp_type == otp_type).order_by(OTP.created_at.desc()).limit(1)
    )
    return r.scalar_one()


# ── FORGOT PASSWORD ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_forgot_password_valid_email_creates_password_reset_otp(client, users, db):
    user = await users.make(SystemRole.EFMS_OFFICER)
    try:
        r = await client.post("/auth/forgot-password", json={"email": user.email})
        assert r.status_code == 200
        otp = await _latest_otp(db, user.email, "password_reset")
        assert otp.is_used is False
        assert len(otp.code) == 6
    finally:
        await _delete_otps(db, user.email)


@pytest.mark.asyncio
async def test_forgot_password_unknown_email_returns_identical_generic_message(client, users, db):
    user = await users.make(SystemRole.EFMS_OFFICER)
    try:
        r1 = await client.post("/auth/forgot-password", json={"email": user.email})
        r2 = await client.post("/auth/forgot-password", json={"email": "definitely.nobody@example.com"})
        assert r1.status_code == r2.status_code == 200
        assert r1.json() == r2.json()  # no enumeration signal in the response
    finally:
        await _delete_otps(db, user.email)


@pytest.mark.asyncio
async def test_forgot_password_verify_correct_otp_returns_reset_token(client, users, db):
    user = await users.make(SystemRole.EFMS_OFFICER)
    try:
        await client.post("/auth/forgot-password", json={"email": user.email})
        otp = await _latest_otp(db, user.email, "password_reset")
        r = await client.post("/auth/forgot-password/verify", json={"email": user.email, "otp": otp.code})
        assert r.status_code == 200
        assert r.json()["reset_token"]
    finally:
        await _delete_otps(db, user.email)


@pytest.mark.asyncio
async def test_forgot_password_verify_wrong_otp_fails(client, users, db):
    user = await users.make(SystemRole.EFMS_OFFICER)
    try:
        await client.post("/auth/forgot-password", json={"email": user.email})
        r = await client.post("/auth/forgot-password/verify", json={"email": user.email, "otp": "000000"})
        assert r.status_code == 400
    finally:
        await _delete_otps(db, user.email)


@pytest.mark.asyncio
async def test_forgot_password_verify_expired_otp_fails(client, users, db):
    user = await users.make(SystemRole.EFMS_OFFICER)
    try:
        await client.post("/auth/forgot-password", json={"email": user.email})
        otp = await _latest_otp(db, user.email, "password_reset")
        otp.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        await db.commit()
        r = await client.post("/auth/forgot-password/verify", json={"email": user.email, "otp": otp.code})
        assert r.status_code == 400
    finally:
        await _delete_otps(db, user.email)


@pytest.mark.asyncio
async def test_forgot_password_used_otp_cannot_be_reused(client, users, db):
    user = await users.make(SystemRole.EFMS_OFFICER)
    try:
        await client.post("/auth/forgot-password", json={"email": user.email})
        otp = await _latest_otp(db, user.email, "password_reset")
        r1 = await client.post("/auth/forgot-password/verify", json={"email": user.email, "otp": otp.code})
        assert r1.status_code == 200
        r2 = await client.post("/auth/forgot-password/verify", json={"email": user.email, "otp": otp.code})
        assert r2.status_code == 400
    finally:
        await _delete_otps(db, user.email)


@pytest.mark.asyncio
async def test_login_otp_cannot_be_used_as_password_reset_otp(client, users, db):
    """otp_type isolation: login uses "email", password reset uses
    "password_reset" — a valid, unused login OTP must not satisfy
    password-reset verification for the same account."""
    user = await users.make(SystemRole.EFMS_OFFICER)
    try:
        r = await client.post("/auth/login/step1", json={"email": user.email, "password": _PASSWORD})
        assert r.status_code == 200
        login_otp = await _latest_otp(db, user.email, "email")
        r = await client.post("/auth/forgot-password/verify", json={"email": user.email, "otp": login_otp.code})
        assert r.status_code == 400
    finally:
        await _delete_otps(db, user.email)


@pytest.mark.asyncio
async def test_password_reset_otp_cannot_be_used_as_login_otp(client, users, db):
    user = await users.make(SystemRole.EFMS_OFFICER)
    try:
        await client.post("/auth/forgot-password", json={"email": user.email})
        reset_otp = await _latest_otp(db, user.email, "password_reset")
        r = await client.post("/auth/login/step2", json={"email": user.email, "otp": reset_otp.code})
        assert r.status_code == 401
    finally:
        await _delete_otps(db, user.email)


@pytest.mark.asyncio
async def test_forgot_password_reset_requires_verified_otp(client, users, db):
    """The final reset step must not accept only email+new_password — it
    requires a reset_token that only exists after successful OTP
    verification. A garbage/missing token must be rejected."""
    user = await users.make(SystemRole.EFMS_OFFICER)
    try:
        r = await client.post(
            "/auth/forgot-password/reset",
            json={"reset_token": "not-a-real-token", "new_password": _NEW_PASSWORD, "confirm_password": _NEW_PASSWORD},
        )
        assert r.status_code == 400
        await db.refresh(user)
        assert verify_password(_PASSWORD, user.hashed_password) is True  # unchanged
    finally:
        await _delete_otps(db, user.email)


@pytest.mark.asyncio
async def test_forgot_password_reset_enforces_password_policy(client, users, db):
    user = await users.make(SystemRole.EFMS_OFFICER)
    try:
        await client.post("/auth/forgot-password", json={"email": user.email})
        otp = await _latest_otp(db, user.email, "password_reset")
        verify_resp = await client.post("/auth/forgot-password/verify", json={"email": user.email, "otp": otp.code})
        reset_token = verify_resp.json()["reset_token"]
        r = await client.post(
            "/auth/forgot-password/reset",
            json={"reset_token": reset_token, "new_password": "weak", "confirm_password": "weak"},
        )
        assert r.status_code == 400
    finally:
        await _delete_otps(db, user.email)


@pytest.mark.asyncio
async def test_forgot_password_full_flow_changes_password_and_clears_must_change_password(client, users, db):
    user = await users.make(SystemRole.EFMS_OFFICER, is_active=True)
    user.must_change_password = True
    await db.commit()
    try:
        await client.post("/auth/forgot-password", json={"email": user.email})
        otp = await _latest_otp(db, user.email, "password_reset")
        verify_resp = await client.post("/auth/forgot-password/verify", json={"email": user.email, "otp": otp.code})
        reset_token = verify_resp.json()["reset_token"]

        r = await client.post(
            "/auth/forgot-password/reset",
            json={"reset_token": reset_token, "new_password": _NEW_PASSWORD, "confirm_password": _NEW_PASSWORD},
        )
        assert r.status_code == 200

        await db.refresh(user)
        assert verify_password(_PASSWORD, user.hashed_password) is False  # old password no longer works
        assert verify_password(_NEW_PASSWORD, user.hashed_password) is True  # new password works
        assert user.must_change_password is False  # not incorrectly forced through first-login flow

        # Old password is rejected at login now.
        r = await client.post("/auth/login/step1", json={"email": user.email, "password": _PASSWORD})
        assert r.status_code == 401
        # New password is accepted.
        r = await client.post("/auth/login/step1", json={"email": user.email, "password": _NEW_PASSWORD})
        assert r.status_code == 200
    finally:
        await _delete_otps(db, user.email)


@pytest.mark.asyncio
async def test_forgot_password_reset_revokes_existing_refresh_tokens(client, users, db):
    from app.models.user import RefreshToken

    user = await users.make(SystemRole.EFMS_OFFICER)
    try:
        # Establish a real session (login step1 -> step2) to get a refresh token.
        await client.post("/auth/login/step1", json={"email": user.email, "password": _PASSWORD})
        login_otp = await _latest_otp(db, user.email, "email")
        login_resp = await client.post("/auth/login/step2", json={"email": user.email, "otp": login_otp.code})
        assert login_resp.status_code == 200
        old_refresh_token = login_resp.json()["refresh_token"]

        # Forgot-password reset.
        await client.post("/auth/forgot-password", json={"email": user.email})
        reset_otp = await _latest_otp(db, user.email, "password_reset")
        verify_resp = await client.post("/auth/forgot-password/verify", json={"email": user.email, "otp": reset_otp.code})
        reset_token = verify_resp.json()["reset_token"]
        r = await client.post(
            "/auth/forgot-password/reset",
            json={"reset_token": reset_token, "new_password": _NEW_PASSWORD, "confirm_password": _NEW_PASSWORD},
        )
        assert r.status_code == 200

        # The pre-reset refresh token must now be revoked.
        r = await client.post("/auth/refresh", json={"refresh_token": old_refresh_token})
        assert r.status_code == 401

        # Cleanup any RefreshToken rows left for this user (FK cascades on
        # user delete anyway, but tidy up explicitly for a clean run).
        await db.execute(sa_delete(RefreshToken).where(RefreshToken.user_id == user.id))
        await db.commit()
    finally:
        await _delete_otps(db, user.email)


@pytest.mark.asyncio
async def test_forgot_password_reset_token_cannot_be_reused(client, users, db):
    """The reset_token itself (not just the OTP) must not be replayable —
    once a password has been reset, the same token must fail a second time
    even though the JWT itself hasn't expired yet."""
    user = await users.make(SystemRole.EFMS_OFFICER)
    try:
        await client.post("/auth/forgot-password", json={"email": user.email})
        otp = await _latest_otp(db, user.email, "password_reset")
        verify_resp = await client.post("/auth/forgot-password/verify", json={"email": user.email, "otp": otp.code})
        reset_token = verify_resp.json()["reset_token"]

        r1 = await client.post(
            "/auth/forgot-password/reset",
            json={"reset_token": reset_token, "new_password": _NEW_PASSWORD, "confirm_password": _NEW_PASSWORD},
        )
        assert r1.status_code == 200

        r2 = await client.post(
            "/auth/forgot-password/reset",
            json={"reset_token": reset_token, "new_password": "AnotherPass1!", "confirm_password": "AnotherPass1!"},
        )
        assert r2.status_code == 400

        await db.refresh(user)
        assert verify_password(_NEW_PASSWORD, user.hashed_password) is True  # unaffected by the replay attempt
    finally:
        await _delete_otps(db, user.email)


# ── CHANGE PASSWORD (authenticated) ──────────────────────────────────────────

@pytest.mark.asyncio
async def test_normal_user_can_change_own_password(client, users, db):
    user = await users.make(SystemRole.EFMS_OFFICER)
    r = await client.post(
        "/auth/change-password",
        json={"current_password": _PASSWORD, "new_password": _NEW_PASSWORD, "confirm_password": _NEW_PASSWORD},
        headers=auth_headers(user),
    )
    assert r.status_code == 200
    await db.refresh(user)
    assert verify_password(_NEW_PASSWORD, user.hashed_password) is True
    assert verify_password(_PASSWORD, user.hashed_password) is False


@pytest.mark.asyncio
async def test_super_admin_can_change_own_password(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    r = await client.post(
        "/auth/change-password",
        json={"current_password": _PASSWORD, "new_password": _NEW_PASSWORD, "confirm_password": _NEW_PASSWORD},
        headers=auth_headers(super_admin),
    )
    assert r.status_code == 200
    await db.refresh(super_admin)
    assert verify_password(_NEW_PASSWORD, super_admin.hashed_password) is True


@pytest.mark.asyncio
async def test_change_password_wrong_current_password_fails(client, users, db):
    user = await users.make(SystemRole.EFMS_OFFICER)
    r = await client.post(
        "/auth/change-password",
        json={"current_password": "WrongPassword1!", "new_password": _NEW_PASSWORD, "confirm_password": _NEW_PASSWORD},
        headers=auth_headers(user),
    )
    assert r.status_code == 401
    await db.refresh(user)
    assert verify_password(_PASSWORD, user.hashed_password) is True  # unchanged


@pytest.mark.asyncio
async def test_change_password_confirmation_mismatch_fails(client, users):
    user = await users.make(SystemRole.EFMS_OFFICER)
    r = await client.post(
        "/auth/change-password",
        json={"current_password": _PASSWORD, "new_password": _NEW_PASSWORD, "confirm_password": "Different1!"},
        headers=auth_headers(user),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_change_password_policy_enforced(client, users):
    user = await users.make(SystemRole.EFMS_OFFICER)
    r = await client.post(
        "/auth/change-password",
        json={"current_password": _PASSWORD, "new_password": "weak", "confirm_password": "weak"},
        headers=auth_headers(user),
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_change_password_cannot_affect_another_user(client, users, db):
    """The endpoint accepts no user id/email at all — identity comes only
    from the caller's own token. Two different users each changing "their"
    password must only ever affect themselves."""
    user_a = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    user_b = await users.make(SystemRole.EFMS_OFFICER, first_name="UserB")

    r = await client.post(
        "/auth/change-password",
        json={"current_password": _PASSWORD, "new_password": _NEW_PASSWORD, "confirm_password": _NEW_PASSWORD},
        headers=auth_headers(user_a),
    )
    assert r.status_code == 200

    await db.refresh(user_a)
    await db.refresh(user_b)
    assert verify_password(_NEW_PASSWORD, user_a.hashed_password) is True
    assert verify_password(_PASSWORD, user_b.hashed_password) is True  # untouched


# ── ADMIN PASSWORD RESET REMOVED ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_admin_reset_password_endpoint_no_longer_exists(client, users):
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    target = await users.make(SystemRole.EFMS_OFFICER)
    r = await client.post(f"/auth/admin/users/{target.id}/reset-password", headers=auth_headers(super_admin))
    assert r.status_code in (404, 405)


@pytest.mark.asyncio
async def test_super_admin_cannot_change_another_users_password_via_change_password(client, users, db):
    """change-password has no target-user parameter at all, so a Super
    Admin authenticated as themselves can only ever change their OWN
    password through it — there is no way to name another account."""
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    target = await users.make(SystemRole.EFMS_OFFICER)
    r = await client.post(
        "/auth/change-password",
        json={"current_password": _PASSWORD, "new_password": _NEW_PASSWORD, "confirm_password": _NEW_PASSWORD},
        headers=auth_headers(super_admin),
    )
    assert r.status_code == 200
    await db.refresh(target)
    assert verify_password(_PASSWORD, target.hashed_password) is True  # target's password is untouched
    await db.refresh(super_admin)
    assert verify_password(_NEW_PASSWORD, super_admin.hashed_password) is True  # only the caller's own changed


# ── FIRST-LOGIN TEMP-PASSWORD FLOW REGRESSION ────────────────────────────────

@pytest.mark.asyncio
async def test_first_login_temp_password_change_flow_still_works(client, users, db):
    user = await users.make(SystemRole.EFMS_OFFICER)
    user.must_change_password = True
    await db.commit()

    r = await client.post(
        "/auth/change-password",
        json={"current_password": _PASSWORD, "new_password": _NEW_PASSWORD, "confirm_password": _NEW_PASSWORD},
        headers=auth_headers(user),
    )
    assert r.status_code == 200
    await db.refresh(user)
    assert user.must_change_password is False
    assert verify_password(_NEW_PASSWORD, user.hashed_password) is True


@pytest.mark.asyncio
async def test_must_change_password_still_blocks_role_gated_endpoints(client, users, db):
    """require_roles() chains through require_password_changed — unchanged
    by this task. A Super Admin who still must change their temp password
    is blocked from admin endpoints until they do."""
    super_admin = await users.make(SystemRole.SUPER_ADMIN)
    super_admin.must_change_password = True
    await db.commit()

    r = await client.get("/auth/admin/users", headers=auth_headers(super_admin))
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "password_change_required"


@pytest.mark.asyncio
async def test_after_first_login_change_voluntary_change_password_also_works(client, users, db):
    """Completing the mandatory first-login change must not prevent using
    the same general endpoint again later (the voluntary Change Password
    flow calls the identical endpoint)."""
    user = await users.make(SystemRole.EFMS_OFFICER)
    user.must_change_password = True
    await db.commit()

    r = await client.post(
        "/auth/change-password",
        json={"current_password": _PASSWORD, "new_password": _NEW_PASSWORD, "confirm_password": _NEW_PASSWORD},
        headers=auth_headers(user),
    )
    assert r.status_code == 200

    second_new_password = "SecondNew1!"
    r = await client.post(
        "/auth/change-password",
        json={"current_password": _NEW_PASSWORD, "new_password": second_new_password, "confirm_password": second_new_password},
        headers=auth_headers(user),
    )
    assert r.status_code == 200
    await db.refresh(user)
    assert verify_password(second_new_password, user.hashed_password) is True
