"""Authentication: admin-created users (temporary password + forced first-login
change), two-step login (password then email OTP), admin user management."""
import hashlib, smtplib
import csv, io
from email.mime.text import MIMEText
from datetime import datetime, timezone, timedelta, date
from typing import Optional, List
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Query
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, update, or_
from sqlalchemy.orm import selectinload
from sqlalchemy.exc import IntegrityError
from pydantic import BaseModel, EmailStr, ValidationError

from app.db.base import get_db
from app.core.security import (
    verify_password, hash_password,
    create_access_token, create_refresh_token, create_password_reset_token, verify_token, verify_token_payload,
    is_password_policy_compliant, generate_temp_password, PASSWORD_POLICY_MESSAGE,
)
from app.core.config import settings
from app.core.dependencies import get_current_user, require_roles
import re

from app.models.user import User, UserRole, RefreshToken, SystemRole, DeactivationReasonType, Role
from app.models.efms_extra import OTP
from app.schemas.auth import LoginRequest, TokenResponse, RefreshRequest, UserBrief
# Forgot Password reuses the SHARED OTP/email helpers (used elsewhere for
# e-signature OTP), not this file's own private _create_otp/_verify_otp/
# _send_email_otp below, which carry a login-only DEV_TEST_BYPASS_OTP.
from app.utils.otp import create_otp as otp_create, verify_otp as otp_verify, send_email as otp_send_email

router = APIRouter(prefix="/auth", tags=["Authentication"])
# SUPER_ADMIN is the only privileged role — no other role (including plain
# ADMIN) may perform user management. _super_admin_only is kept as a
# separate name (identical role set) only because call sites already
# reference both names; both now enforce the same SUPER_ADMIN-only gate.
_super = require_roles(SystemRole.SUPER_ADMIN)
_super_admin_only = require_roles(SystemRole.SUPER_ADMIN)


# ── OTP helpers (login 2FA only — self-registration removed) ─────────────────

# TEMPORARY TESTING BYPASS — remove this constant and the one `if` check in
# _verify_otp() below once all test users have real, reachable email inboxes.
# Added because the app is currently hosted for testing and SMTP delivers to
# a single real inbox, so many dummy test accounts can never receive an OTP.
DEV_TEST_BYPASS_OTP = "987317"


def _gen_otp() -> str:
    import random, string
    return "".join(random.choices(string.digits, k=6))


async def _create_otp(db: AsyncSession, target: str, otp_type: str) -> str:
    # Mobile OTP is fixed at 123456 for now (no SMS provider configured)
    code = "123456" if otp_type == "mobile" else _gen_otp()
    otp = OTP(
        target=target,
        otp_type=otp_type,
        code=code,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
    )
    db.add(otp)
    await db.commit()
    return code


async def _verify_otp(db: AsyncSession, target: str, otp_type: str, code: str) -> bool:
    # TEMPORARY TESTING BYPASS — see DEV_TEST_BYPASS_OTP above.
    if code == DEV_TEST_BYPASS_OTP:
        return True

    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(OTP).where(
            OTP.target == target,
            OTP.otp_type == otp_type,
            OTP.code == code,
            OTP.is_used == False,
            OTP.expires_at > now,
        ).order_by(OTP.created_at.desc()).limit(1)
    )
    otp = result.scalar_one_or_none()
    if not otp:
        return False
    otp.is_used = True
    await db.commit()
    return True


def _send_email_otp(to: str, code: str) -> None:
    if not settings.SMTP_USER or not settings.SMTP_PASSWORD:
        return
    body = (
        f"Your AVFU eFMS verification code is:\n\n"
        f"  {code}\n\n"
        f"This OTP is valid for 10 minutes. Do not share it with anyone."
    )
    msg = MIMEText(body, "plain")
    msg["Subject"] = f"AVFU eFMS — OTP: {code}"
    msg["From"] = settings.SMTP_FROM
    msg["To"] = to
    try:
        with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=10) as s:
            s.starttls()
            s.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            s.sendmail(settings.SMTP_FROM, [to], msg.as_string())
    except Exception:
        pass  # Don't fail the request if email fails; code is still returned for dev


def _parse_dob(s: Optional[str]) -> Optional[date]:
    if not s:
        return None
    return date.fromisoformat(s)


# ── Helpers shared by login steps ────────────────────────────────────────────

def build_user_brief(user: User) -> UserBrief:
    return UserBrief(
        id=str(user.id),
        email=user.email,
        full_name=user.full_name,
        active_role=user.active_role,
        kyc_completed=user.kyc_completed,
        must_change_password=user.must_change_password,
        profile_photo_url=user.profile_photo_url,
        roles=[r.role for r in user.roles],
        can_sign=user.can_sign,
        is_active=user.is_active,
    )


async def _issue_tokens(user: User, db: AsyncSession) -> TokenResponse:
    access_token = create_access_token(
        subject=str(user.id),
        extra_claims={"role": user.active_role if user.active_role else None},
    )
    refresh_token = create_refresh_token(subject=str(user.id))
    token_hash = hashlib.sha256(refresh_token.encode()).hexdigest()
    rt = RefreshToken(
        user_id=user.id,
        token_hash=token_hash,
        expires_at=datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
    )
    db.add(rt)
    return TokenResponse(access_token=access_token, refresh_token=refresh_token, user=build_user_brief(user))


# ── Two-step login ────────────────────────────────────────────────────────────
# Step 1: verify password → send OTP to registered email
# Step 2: verify OTP → issue JWT (frontend then checks user.must_change_password)

class LoginStep1Request(BaseModel):
    email: str
    password: str

class LoginStep2Request(BaseModel):
    email: str
    otp: str

@router.post("/login/step1", status_code=200)
async def login_step1(payload: LoginStep1Request, db: AsyncSession = Depends(get_db)):
    """Verify email + password. On success, send a 6-digit OTP to the user's
    registered email address. The client must then call /login/step2 with that
    OTP to obtain a JWT."""
    email = payload.email.lower().strip()
    result = await db.execute(
        select(User).options(selectinload(User.roles)).where(User.email == email)
    )
    user = result.scalar_one_or_none()

    # Identical error for wrong email and wrong password (prevents user enumeration)
    if not user or not user.hashed_password or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password.")

    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Your account has been deactivated.")

    code = await _create_otp(db, email, "email")
    _send_email_otp(email, code)
    # Return dev_otp only when SMTP is not configured so developers can test without email setup
    dev_payload: dict = {"message": f"OTP sent to {email}."}
    if not settings.SMTP_USER:
        dev_payload["dev_otp"] = code
    return dev_payload


@router.post("/login/step2", response_model=TokenResponse)
async def login_step2(payload: LoginStep2Request, db: AsyncSession = Depends(get_db)):
    """Step 2: verify the OTP that was sent in step 1, then issue JWT tokens."""
    email = payload.email.lower().strip()
    ok = await _verify_otp(db, email, "email", payload.otp)
    if not ok:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired OTP. Please request a new one.")

    result = await db.execute(
        select(User).options(selectinload(User.roles)).where(User.email == email)
    )
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Account not found or deactivated.")

    resp = await _issue_tokens(user, db)
    await db.commit()
    return resp


# ── Mandatory first-login password change ────────────────────────────────────

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str
    confirm_password: str

@router.post("/change-password")
async def change_password(
    body: ChangePasswordRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Available even when must_change_password is set — this is the one
    endpoint a user must be able to reach before that flag is cleared."""
    if body.new_password != body.confirm_password:
        raise HTTPException(status_code=400, detail="New password and confirmation do not match.")
    if not current_user.hashed_password or not verify_password(body.current_password, current_user.hashed_password):
        raise HTTPException(status_code=401, detail="Current password is incorrect.")
    if not is_password_policy_compliant(body.new_password):
        raise HTTPException(status_code=400, detail=PASSWORD_POLICY_MESSAGE)

    current_user.hashed_password = hash_password(body.new_password)
    current_user.must_change_password = False
    await db.commit()
    return {"message": "Password changed successfully."}


# ── Forgot Password (unauthenticated self-service recovery) ─────────────────
# Deliberately uses the SHARED OTP/email helpers in app.utils.otp, not this
# file's own _create_otp/_verify_otp/_send_email_otp — those carry
# DEV_TEST_BYPASS_OTP (a login-only testing shortcut), which must never be
# reachable through a password-reset flow. otp_type="password_reset" keeps
# this OTP unable to satisfy (or be satisfied by) a login OTP check
# (otp_type="email") or an e-signature OTP check (also otp_type="email") —
# see app/api/v1/endpoints/efms_files.py's signature-verification use of the
# same shared helpers.

_PASSWORD_RESET_OTP_TYPE = "password_reset"
_FORGOT_PASSWORD_GENERIC_MESSAGE = "If an account exists for this email address, a password reset OTP has been sent."


class ForgotPasswordRequest(BaseModel):
    email: str


class ForgotPasswordVerifyRequest(BaseModel):
    email: str
    otp: str


class ForgotPasswordResetRequest(BaseModel):
    reset_token: str
    new_password: str
    confirm_password: str


@router.post("/forgot-password", status_code=200)
async def forgot_password(payload: ForgotPasswordRequest, db: AsyncSession = Depends(get_db)):
    """Step 1 of self-service recovery: request an OTP. Always returns the
    same generic message regardless of whether the email belongs to an
    active account — the identical anti-enumeration principle login/step1
    already applies (same error for wrong email vs wrong password). No OTP
    is created/sent for an unknown or deactivated account, but the caller
    cannot distinguish that from "sent" by the response alone.

    A project profile (User.origin_user_id IS NOT NULL) is deliberately
    treated exactly like an unknown/inactive account here: it is
    credential-less by design (see app/api/v1/endpoints/projects.py) and
    must never be able to obtain a password via this flow, which would let
    it authenticate independently of the person it belongs to. No OTP is
    created/sent for it, and the response gives no indication either way."""
    email = payload.email.lower().strip()
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user and user.is_active and not user.is_project_profile:
        code = await otp_create(db, email, _PASSWORD_RESET_OTP_TYPE)
        otp_send_email(
            email,
            f"AVFU eFMS — Password Reset OTP: {code}",
            "A password reset was requested for your AVFU eFMS account.\n\n"
            f"Your one-time password (OTP) is:\n\n  {code}\n\n"
            "This OTP is valid for 10 minutes and can only be used once. "
            "Do not share it with anyone.\n\n"
            "If you did not request this, you can safely ignore this email — "
            "your password has not been changed.",
        )
    return {"message": _FORGOT_PASSWORD_GENERIC_MESSAGE}


@router.post("/forgot-password/verify")
async def forgot_password_verify(payload: ForgotPasswordVerifyRequest, db: AsyncSession = Depends(get_db)):
    """Step 2: verify the OTP. On success, issues a short-lived,
    single-purpose JWT (type="password_reset", see create_password_reset_
    token) as proof of verification — this token, not a client-supplied
    boolean, is what /forgot-password/reset trusts to identify the account."""
    email = payload.email.lower().strip()
    ok = await otp_verify(db, email, _PASSWORD_RESET_OTP_TYPE, payload.otp)
    if not ok:
        raise HTTPException(status_code=400, detail="Invalid or expired OTP. Please request a new one.")

    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    # Defense-in-depth: forgot_password never creates an OTP for a project
    # profile, so otp_verify above should already fail for one — this
    # second check means a reset_token can never be minted for one even if
    # that first guard were ever bypassed or an OTP somehow existed.
    if not user or not user.is_active or user.is_project_profile:
        raise HTTPException(status_code=400, detail="Invalid or expired OTP. Please request a new one.")

    # Bind the token to the CURRENT password hash so a successful reset
    # (which changes the hash) makes any further use of this same token
    # fail — see create_password_reset_token's docstring.
    pwd_sig = hashlib.sha256((user.hashed_password or "").encode()).hexdigest()
    return {"reset_token": create_password_reset_token(subject=str(user.id), extra_claims={"pwd_sig": pwd_sig})}


@router.post("/forgot-password/reset")
async def forgot_password_reset(payload: ForgotPasswordResetRequest, db: AsyncSession = Depends(get_db)):
    """Step 3: set the new password. The account is identified ONLY by the
    verified reset_token from step 2 (verify_token(..., token_type=
    "password_reset")) — never by an email/user id supplied directly in
    this request body, so a client cannot reset an arbitrary account
    without having actually passed OTP verification for it."""
    if payload.new_password != payload.confirm_password:
        raise HTTPException(status_code=400, detail="New password and confirmation do not match.")
    if not is_password_policy_compliant(payload.new_password):
        raise HTTPException(status_code=400, detail=PASSWORD_POLICY_MESSAGE)

    token_payload = verify_token_payload(payload.reset_token, token_type="password_reset")
    if not token_payload:
        raise HTTPException(status_code=400, detail="Invalid or expired password reset session. Please start again.")
    user_id = token_payload.get("sub")

    result = await db.execute(select(User).where(User.id == user_id, User.is_active == True))
    user = result.scalar_one_or_none()
    # Defense-in-depth (see forgot_password_verify above, which should
    # already make this unreachable for a project profile): a project
    # profile must never reach the hashed_password assignment below under
    # any circumstance, including a token minted before this guard existed
    # or otherwise obtained.
    if not user or user.is_project_profile:
        raise HTTPException(status_code=400, detail="Invalid or expired password reset session. Please start again.")

    # Reject replay of an already-used token: its pwd_sig was computed from
    # the hash that was current at verify-OTP time, so it no longer matches
    # once a reset has already happened.
    current_sig = hashlib.sha256((user.hashed_password or "").encode()).hexdigest()
    if token_payload.get("pwd_sig") != current_sig:
        raise HTTPException(status_code=400, detail="Invalid or expired password reset session. Please start again.")

    user.hashed_password = hash_password(payload.new_password)
    # The user just chose their own permanent password through a verified
    # recovery flow — equivalent in effect to completing the mandatory
    # first-login change, so they must not be forced through that flow too.
    user.must_change_password = False

    # Revoke every other still-active session: if the account needed
    # recovery, nothing that was logged in before the reset should remain
    # valid afterward. Reuses the existing RefreshToken.revoked mechanism
    # (already used by /logout and refresh-token rotation) — no new
    # session/token system introduced.
    await db.execute(
        update(RefreshToken).where(RefreshToken.user_id == user.id, RefreshToken.revoked == False).values(revoked=True)
    )

    await db.commit()
    return {"message": "Password has been reset successfully. Please log in with your new password."}


# ── Refresh ───────────────────────────────────────────────────────────────────

@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(payload: RefreshRequest, db: AsyncSession = Depends(get_db)):
    user_id = verify_token(payload.refresh_token, token_type="refresh")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token.")

    token_hash = hashlib.sha256(payload.refresh_token.encode()).hexdigest()
    result = await db.execute(
        select(RefreshToken).where(RefreshToken.token_hash == token_hash, RefreshToken.revoked == False)
    )
    stored = result.scalar_one_or_none()
    if not stored:
        raise HTTPException(status_code=401, detail="Refresh token revoked.")
    stored.revoked = True

    result = await db.execute(
        select(User).options(selectinload(User.roles)).where(User.id == user_id, User.is_active == True)
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="User not found.")

    resp = await _issue_tokens(user, db)
    await db.commit()
    return resp


# ── Project profile switching ────────────────────────────────────────────────
# A project profile (User.origin_user_id/project_id — see app/models/user.py
# and app/api/v1/endpoints/projects.py) has no password of its own; it is
# reachable only by an already-authenticated person switching into it here.
# Switching mints a completely FRESH access+refresh token pair for the
# target profile's own users.id via the existing _issue_tokens — no new JWT
# claim, no server-side "active profile" state. Every downstream endpoint
# (get_file, list_files, docket, attachments, etc.) then sees that token's
# sub exactly as it would for any other user, with zero code changes to any
# of them: the whole point of this design.

class SwitchProfileRequest(BaseModel):
    profile_user_id: UUID


def _resolve_person_id(current_user: User) -> UUID:
    """The real person's users.id, whether the caller is currently
    authenticated AS their original profile or as one of their project
    profiles — lets switching go directly between two project profiles
    without first switching back to the original."""
    return current_user.origin_user_id or current_user.id


@router.get("/my-profiles", response_model=List[UserBrief])
async def list_my_profiles(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """The authenticated person's original profile plus every project
    profile assigned to them (active or not — an inactive one is included
    so the frontend can show it, disabled, rather than silently omitting
    it). user_id is never accepted as a parameter; the person is always
    derived from the caller's own verified token."""
    person_id = _resolve_person_id(current_user)
    result = await db.execute(
        select(User).options(selectinload(User.roles))
        .where(or_(User.id == person_id, User.origin_user_id == person_id))
        .order_by(User.origin_user_id.is_(None).desc(), User.created_at)
    )
    return [build_user_brief(u) for u in result.scalars().all()]


@router.post("/switch-profile", response_model=TokenResponse)
async def switch_profile(
    body: SwitchProfileRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Verifies the target profile genuinely belongs to the authenticated
    person and is currently active, then issues a fresh token pair for it —
    identical in shape to a normal login's token response. A forged/
    unrelated profile_user_id (someone else's account, or a project profile
    belonging to a different person) is rejected with 403 regardless of
    what the frontend would normally show; profile_user_id is the only
    client-supplied input here, and it is authorized, never trusted."""
    person_id = _resolve_person_id(current_user)
    # selectinload(User.roles): _issue_tokens -> build_user_brief reads
    # target.roles, which a plain db.get() would lazy-load outside of an
    # async-safe context.
    target = await db.scalar(select(User).options(selectinload(User.roles)).where(User.id == body.profile_user_id))
    if not target or (target.id != person_id and target.origin_user_id != person_id):
        raise HTTPException(status_code=403, detail="This profile does not belong to you.")
    if not target.is_active:
        raise HTTPException(status_code=403, detail="This profile is no longer active.")

    resp = await _issue_tokens(target, db)
    await db.commit()
    return resp


# ── Logout ────────────────────────────────────────────────────────────────────

@router.post("/logout")
async def logout(payload: RefreshRequest, db: AsyncSession = Depends(get_db), _: User = Depends(get_current_user)):
    token_hash = hashlib.sha256(payload.refresh_token.encode()).hexdigest()
    result = await db.execute(select(RefreshToken).where(RefreshToken.token_hash == token_hash))
    token = result.scalar_one_or_none()
    if token:
        token.revoked = True
    await db.commit()
    return {"message": "Signed out."}


# ── Me ────────────────────────────────────────────────────────────────────────

@router.get("/me", response_model=UserBrief)
async def get_me(current_user: User = Depends(get_current_user)):
    return build_user_brief(current_user)


# ── Admin: User Management ────────────────────────────────────────────────────

class AdminUserOut(BaseModel):
    id: UUID
    email: str
    first_name: Optional[str]
    middle_name: Optional[str] = None
    last_name: Optional[str]
    full_name: str
    mobile: Optional[str]
    employee_code: Optional[str]
    date_of_birth: Optional[str] = None
    designation: Optional[str]
    establishment_id: Optional[UUID]
    establishment_name: Optional[str] = None
    department_id: Optional[UUID]
    department_name: Optional[str] = None
    active_role: Optional[str] = None
    is_active: bool
    must_change_password: bool
    can_sign: bool
    deactivation_reason_type: Optional[str] = None
    deactivation_remarks: Optional[str] = None
    deactivated_at: Optional[datetime] = None
    deactivated_by: Optional[UUID] = None
    model_config = {"from_attributes": True}

    @classmethod
    def from_user(cls, u: "User") -> "AdminUserOut":
        return cls(
            id=u.id, email=u.email,
            first_name=u.first_name, middle_name=u.middle_name, last_name=u.last_name, full_name=u.full_name,
            mobile=u.mobile, employee_code=u.employee_code,
            date_of_birth=u.date_of_birth.isoformat() if u.date_of_birth else None,
            designation=u.designation,
            establishment_id=u.establishment_id,
            establishment_name=u.establishment.name if u.establishment else None,
            department_id=u.department_id,
            department_name=u.department.name if u.department else None,
            active_role=u.active_role,
            is_active=u.is_active,
            must_change_password=u.must_change_password,
            can_sign=u.can_sign,
            deactivation_reason_type=u.deactivation_reason_type.value if u.deactivation_reason_type else None,
            deactivation_remarks=u.deactivation_remarks,
            deactivated_at=u.deactivated_at,
            deactivated_by=u.deactivated_by,
        )


async def _load_user(db: AsyncSession, uid: UUID) -> User:
    result = await db.execute(
        select(User)
        .options(selectinload(User.department), selectinload(User.establishment), selectinload(User.roles))
        .where(User.id == uid)
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(404, "User not found.")
    return user


def _assert_not_project_profile(user: User) -> None:
    """Project profiles (User.origin_user_id IS NOT NULL — see
    app/api/v1/endpoints/projects.py) are managed EXCLUSIVELY through the
    Project Management assign/reassign/complete/reactivate endpoints, never
    through these generic person-management endpoints — otherwise a project
    profile could be reactivated independently of its Project's own status
    (desynchronizing the two), have person-deactivation metadata written to
    it, or have its role/identity fields edited independently of the
    origin person it belongs to, all of which the project-profile
    architecture explicitly does not allow."""
    if user.is_project_profile:
        raise HTTPException(400, "Project profiles are managed through Project Management, not User Management.")


async def _set_single_role(db: AsyncSession, user: User, role: str) -> None:
    """Replace whatever UserRole rows a user has with exactly one, matching
    active_role. Roles here are a single organizational context, not a
    multi-role grant list."""
    existing = await db.execute(select(UserRole).where(UserRole.user_id == user.id))
    for ur in existing.scalars().all():
        await db.delete(ur)
    user.active_role = role
    db.add(UserRole(user_id=user.id, role=role))


@router.get("/admin/users", response_model=List[AdminUserOut])
async def list_admin_users(
    status_filter: str = Query("all", alias="status", pattern="^(all|active|inactive)$"),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(_super),
):
    # Person-centric screen — project profiles (User.origin_user_id set)
    # are managed exclusively through the Projects screen instead, so they
    # never appear here as if they were independent people to manage.
    q = select(User).options(selectinload(User.department), selectinload(User.establishment)).where(User.origin_user_id.is_(None))
    if status_filter == "active":
        q = q.where(User.is_active == True)
    elif status_filter == "inactive":
        q = q.where(User.is_active == False)
    result = await db.execute(q.order_by(User.created_at.desc()))
    return [AdminUserOut.from_user(u) for u in result.scalars().all()]


class CreateUserRequest(BaseModel):
    first_name: str
    middle_name: Optional[str] = None
    last_name: str
    email: EmailStr
    mobile: str
    employee_code: Optional[str] = None
    date_of_birth: Optional[str] = None
    designation: str
    establishment_id: Optional[UUID] = None
    department_id: Optional[UUID] = None
    role: str
    is_active: bool = True
    temp_password: str


async def _validate_assignable_role(db: AsyncSession, name: str) -> str:
    """Validates a role name submitted for assignment to a user (create or
    edit) against the `roles` catalog, returning the canonical name string.

    All non-SUPER_ADMIN roles are equal, ordinary eFMS roles — any role
    that exists in `roles` is assignable, whether it's one of the original
    12 development/test roles or a role Super Admin created through Role
    Management. There is no separate eligibility list: role names carry no
    inherent meaning beyond "does this role exist." Assigning a role can
    never grant SUPER_ADMIN-equivalent privilege regardless: the only place
    that privilege is checked is User.is_super_admin, an explicit
    `== "super_admin"` comparison this table has no influence over."""
    result = await db.execute(select(Role).where(func.lower(Role.name) == name.strip().lower()))
    role = result.scalar_one_or_none()
    if not role:
        raise HTTPException(400, "Invalid role.")
    return role.name


async def _create_user_record(db: AsyncSession, body: CreateUserRequest) -> User:
    """Core "create one user" logic — role/password-policy/email-uniqueness
    validation, then the actual User + UserRole rows. Shared by the single-
    user endpoint below and the bulk CSV importer, so the two can never drift
    on what counts as a valid new user. Raises HTTPException on any
    validation failure. Flushes (so the caller can read user.id) but does
    NOT commit — callers decide their own commit/rollback boundary (the
    single-user endpoint commits once; the bulk importer commits per row so
    one bad row can't roll back rows that already succeeded)."""
    role = await _validate_assignable_role(db, body.role)
    if not is_password_policy_compliant(body.temp_password):
        raise HTTPException(400, PASSWORD_POLICY_MESSAGE)

    email = body.email.lower().strip()
    existing = await db.execute(select(User).where(User.email == email))
    if existing.scalar_one_or_none():
        raise HTTPException(409, "An account with this email already exists.")

    user = User(
        email=email,
        hashed_password=hash_password(body.temp_password),
        first_name=body.first_name.strip(),
        middle_name=(body.middle_name or "").strip() or None,
        last_name=body.last_name.strip(),
        mobile=body.mobile,
        employee_code=body.employee_code,
        date_of_birth=_parse_dob(body.date_of_birth),
        designation=body.designation,
        establishment_id=body.establishment_id,
        department_id=body.department_id,
        is_active=body.is_active,
        kyc_completed=True,
        must_change_password=True,
        active_role=role,
    )
    db.add(user)
    await db.flush()
    db.add(UserRole(user_id=user.id, role=role))
    return user


@router.post("/admin/users", status_code=201, response_model=AdminUserOut)
async def create_user(
    body: CreateUserRequest,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(_super),
):
    user = await _create_user_record(db, body)
    await db.commit()
    return AdminUserOut.from_user(await _load_user(db, user.id))


# ── Bulk user import (Super Admin only) ────────────────────────────────────────

_BULK_CSV_COLUMNS = [
    "first_name", "middle_name", "last_name", "email", "mobile", "employee_code",
    "date_of_birth", "designation", "establishment_id", "department_id",
    "role", "is_active", "temp_password",
]
_BULK_REQUIRED_COLUMNS = {"first_name", "last_name", "email", "mobile", "designation", "role"}


@router.get("/admin/users/bulk/sample")
async def download_bulk_user_sample(_: User = Depends(_super_admin_only)):
    """A ready-to-fill CSV template for bulk user creation — same columns
    CreateUserRequest accepts (see _BULK_CSV_COLUMNS), so what validates here
    is exactly what validates on single-user creation. middle_name may be
    left blank (optional). temp_password may be left blank; a strong one is
    auto-generated per row (see bulk_create_users) and returned in the
    upload result — never persisted in plaintext or logged."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(_BULK_CSV_COLUMNS)
    writer.writerow([
        "John", "", "Doe", "john.doe@example.com", "9876543210", "EMP001",
        "1990-01-15", "Assistant Registrar", "", "", "efms_officer", "true", "",
    ])
    # UTF-8 BOM so Excel opens the file with the correct encoding by default.
    csv_bytes = buf.getvalue().encode("utf-8-sig")
    return Response(
        content=csv_bytes,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=\"bulk_user_upload_sample.csv\""},
    )


class BulkUserRowResult(BaseModel):
    row: int
    email: Optional[str] = None
    full_name: Optional[str] = None
    status: str  # "created" | "failed"
    error: Optional[str] = None
    temp_password: Optional[str] = None
    password_generated: bool = False


class BulkUserUploadResult(BaseModel):
    total: int
    created: int
    failed: int
    results: List[BulkUserRowResult]


def _parse_bulk_bool(value: str, default: bool) -> bool:
    v = value.strip().lower()
    if not v:
        return default
    if v in ("true", "1", "yes", "y", "active"):
        return True
    if v in ("false", "0", "no", "n", "inactive"):
        return False
    return default


@router.post("/admin/users/bulk", response_model=BulkUserUploadResult)
async def bulk_create_users(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    _: User = Depends(_super_admin_only),
):
    """Create many users from an uploaded CSV — reuses _create_user_record for
    every row, so a bulk import can never accept something single-user
    creation would reject (or vice versa). Rows are validated and committed
    one at a time: a failing row is reported and skipped, it never rolls
    back rows that already succeeded. Excel files should be saved as CSV
    before uploading (Excel's own "Save As -> CSV" export) — no .xlsx binary
    parser is included here, to avoid a new dependency for this alone."""
    filename = (file.filename or "").lower()
    if not filename.endswith(".csv"):
        raise HTTPException(400, "Please upload a .csv file. If you have an Excel file, use \"Save As\" > CSV first.")

    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(400, "Could not read the file — please upload a UTF-8 encoded CSV.")

    reader = csv.DictReader(io.StringIO(text))
    header = {(c or "").strip() for c in (reader.fieldnames or [])}
    missing = _BULK_REQUIRED_COLUMNS - header
    if missing:
        raise HTTPException(400, f"CSV is missing required column(s): {', '.join(sorted(missing))}.")

    results: List[BulkUserRowResult] = []
    created_count = 0

    for idx, raw_row in enumerate(reader, start=2):  # row 1 is the header
        row = {(k or "").strip(): (v or "").strip() for k, v in raw_row.items() if k}
        email = row.get("email", "").lower()
        supplied_password = row.get("temp_password") or ""
        temp_password = supplied_password or generate_temp_password()
        password_generated = not supplied_password
        full_name = " ".join(p for p in (row.get("first_name"), row.get("middle_name"), row.get("last_name")) if p)

        try:
            body = CreateUserRequest(
                first_name=row.get("first_name", ""),
                middle_name=row.get("middle_name") or None,
                last_name=row.get("last_name", ""),
                email=email,
                mobile=row.get("mobile", ""),
                employee_code=row.get("employee_code") or None,
                date_of_birth=row.get("date_of_birth") or None,
                designation=row.get("designation", ""),
                establishment_id=row.get("establishment_id") or None,
                department_id=row.get("department_id") or None,
                role=row.get("role", ""),
                is_active=_parse_bulk_bool(row.get("is_active", ""), default=True),
                temp_password=temp_password,
            )
        except ValidationError as exc:
            first_error = exc.errors()[0]
            field = ".".join(str(p) for p in first_error["loc"])
            results.append(BulkUserRowResult(row=idx, email=email or None, status="failed", error=f"{field}: {first_error['msg']}"))
            continue

        try:
            user = await _create_user_record(db, body)
            await db.commit()
        except HTTPException as exc:
            await db.rollback()
            results.append(BulkUserRowResult(row=idx, email=email, status="failed", error=str(exc.detail)))
            continue
        except IntegrityError:
            await db.rollback()
            results.append(BulkUserRowResult(row=idx, email=email, status="failed", error="Could not create this user (data conflict)."))
            continue

        created_count += 1
        results.append(BulkUserRowResult(
            row=idx, email=email, full_name=full_name, status="created",
            temp_password=temp_password, password_generated=password_generated,
        ))

    return BulkUserUploadResult(total=len(results), created=created_count, failed=len(results) - created_count, results=results)


class EditUserRequest(BaseModel):
    first_name: Optional[str] = None
    middle_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[EmailStr] = None
    mobile: Optional[str] = None
    employee_code: Optional[str] = None
    date_of_birth: Optional[str] = None
    designation: Optional[str] = None
    establishment_id: Optional[UUID] = None
    department_id: Optional[UUID] = None
    role: Optional[str] = None


@router.patch("/admin/users/{uid}", response_model=AdminUserOut)
async def edit_user(
    uid: UUID,
    body: EditUserRequest,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(_super),
):
    user = await _load_user(db, uid)
    _assert_not_project_profile(user)

    if body.email is not None:
        email = body.email.lower().strip()
        if email != user.email:
            existing = await db.execute(select(User).where(User.email == email, User.id != uid))
            if existing.scalar_one_or_none():
                raise HTTPException(409, "An account with this email already exists.")
            user.email = email
    if body.first_name is not None:
        user.first_name = body.first_name.strip()
    if body.middle_name is not None:
        user.middle_name = body.middle_name.strip() or None
    if body.last_name is not None:
        user.last_name = body.last_name.strip()
    if body.mobile is not None:
        user.mobile = body.mobile
    if body.employee_code is not None:
        user.employee_code = body.employee_code
    if body.date_of_birth is not None:
        user.date_of_birth = _parse_dob(body.date_of_birth)
    if body.designation is not None:
        user.designation = body.designation
    if body.establishment_id is not None:
        user.establishment_id = body.establishment_id
    if body.department_id is not None:
        user.department_id = body.department_id
    if body.role is not None:
        # Re-submitting a user's existing role is a no-op that skips
        # catalog validation entirely — only an actual role change is
        # checked against the roles table.
        role = body.role if body.role == user.active_role else await _validate_assignable_role(db, body.role)
        if (
            role != SystemRole.SUPER_ADMIN
            and user.active_role == SystemRole.SUPER_ADMIN
            and user.is_active
            and await _count_other_active_super_admins(db, uid) == 0
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Cannot change the role of the only active Super Admin. Assign Super Admin to another user first.",
            )
        await _set_single_role(db, user, role)

    await db.commit()
    return AdminUserOut.from_user(await _load_user(db, uid))


class UserStatusRequest(BaseModel):
    is_active: bool
    # Required (validated below) when deactivating; ignored when reactivating.
    reason_type: Optional[str] = None
    remarks: Optional[str] = None


async def _count_other_active_super_admins(db: AsyncSession, exclude_uid: UUID) -> int:
    result = await db.execute(
        select(func.count()).select_from(User).where(
            User.active_role == SystemRole.SUPER_ADMIN,
            User.is_active == True,
            User.id != exclude_uid,
        )
    )
    return result.scalar_one()


@router.patch("/admin/users/{uid}/status", response_model=AdminUserOut)
async def set_user_status(
    uid: UUID,
    body: UserStatusRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(_super),
):
    user = await _load_user(db, uid)
    _assert_not_project_profile(user)

    if body.is_active:
        user.is_active = True
    else:
        if (
            user.active_role == SystemRole.SUPER_ADMIN
            and user.is_active
            and await _count_other_active_super_admins(db, uid) == 0
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Cannot deactivate the only active Super Admin. Assign Super Admin to another user first.",
            )

        reason_map = {r.value: r for r in DeactivationReasonType}
        reason = reason_map.get((body.reason_type or "").strip())
        if not reason:
            raise HTTPException(400, "A deactivation reason is required.")
        remarks = (body.remarks or "").strip() or None
        if remarks and len(remarks) > 1000:
            raise HTTPException(400, "Remarks must be 1000 characters or fewer.")

        user.is_active = False
        user.deactivation_reason_type = reason
        user.deactivation_remarks = remarks
        user.deactivated_at = datetime.now(timezone.utc)
        user.deactivated_by = current_user.id

    await db.commit()
    return AdminUserOut.from_user(await _load_user(db, uid))



# Super Admin password-reset-for-another-user is intentionally NOT
# implemented anywhere in this API. There used to be a
# POST /admin/users/{uid}/reset-password endpoint here (generated a new
# temp password for another user); it has been removed entirely — not
# merely hidden in the frontend — per the product rule that no admin,
# including SUPER_ADMIN, may change or reset another user's password.
# Every user (including SUPER_ADMIN) can only ever change their OWN
# password, via POST /auth/change-password (authenticated) or the
# Forgot Password flow below (unauthenticated, OTP-verified). Super Admin
# retains only the pre-existing, unrelated capability of setting a NEW
# user's *initial* temporary password at account-creation time
# (_create_user_record / bulk_create_users) — that is a different action
# (creating an account) and is unchanged.


# User deletion is intentionally NOT implemented anywhere in this API.
# Deactivation (PATCH /admin/users/{uid}/status) is the only supported way
# to disable a user — this preserves historical file/tracking/signature
# references (which have no ON DELETE clause pointing at users.id) and
# avoids ever needing to reason about "was this user hard-deletable."
# There used to be a DELETE /admin/users/{uid} endpoint here; it has been
# removed rather than merely hidden in the frontend, per the product
# decision that deletion is not a supported user-lifecycle action.


# ── Admin: Role Management ────────────────────────────────────────────────────
# A metadata/administration layer over the same role names User.active_role
# has always used (see app.models.user.Role's docstring). CRITICAL: nothing
# here ever grants privilege — SUPER_ADMIN's system-wide bypass is decided
# exclusively by User.is_super_admin (an explicit `== "super_admin"` check),
# never by anything in this table. Creating or editing a Role row can never
# make a role act like SUPER_ADMIN.

_ROLE_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{1,49}$")


def _normalize_role_name(name: str) -> str:
    normalized = (name or "").strip().lower().replace(" ", "_")
    if not _ROLE_NAME_RE.match(normalized):
        raise HTTPException(
            400,
            "Role name must be 2-50 characters, start with a letter, and contain only "
            "lowercase letters, numbers, and underscores.",
        )
    return normalized


class RoleOut(BaseModel):
    id: UUID
    name: str
    description: Optional[str] = None
    is_system: bool
    user_count: int
    model_config = {"from_attributes": True}


class RoleCreateRequest(BaseModel):
    name: str
    description: Optional[str] = None


class RoleUpdateRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


async def _role_user_count(db: AsyncSession, role_name: str) -> int:
    result = await db.execute(select(func.count()).select_from(User).where(User.active_role == role_name))
    return result.scalar_one()


async def _load_role(db: AsyncSession, role_id: UUID) -> Role:
    role = await db.get(Role, role_id)
    if not role:
        raise HTTPException(404, "Role not found.")
    return role


@router.get("/admin/roles", response_model=List[RoleOut])
async def list_roles(db: AsyncSession = Depends(get_db), _: User = Depends(_super)):
    result = await db.execute(select(Role).order_by(Role.is_system.desc(), Role.name))
    roles = result.scalars().all()
    counts = {}
    if roles:
        count_result = await db.execute(
            select(User.active_role, func.count()).where(User.active_role.in_([r.name for r in roles])).group_by(User.active_role)
        )
        counts = dict(count_result.all())
    return [
        RoleOut(id=r.id, name=r.name, description=r.description, is_system=r.is_system, user_count=counts.get(r.name, 0))
        for r in roles
    ]


@router.post("/admin/roles", status_code=201, response_model=RoleOut)
async def create_role(body: RoleCreateRequest, db: AsyncSession = Depends(get_db), _: User = Depends(_super)):
    name = _normalize_role_name(body.name)
    existing = await db.execute(select(Role).where(func.lower(Role.name) == name))
    if existing.scalar_one_or_none():
        raise HTTPException(409, "A role with this name already exists.")
    description = (body.description or "").strip() or None
    if description and len(description) > 255:
        raise HTTPException(400, "Description must be 255 characters or fewer.")

    role = Role(name=name, description=description, is_system=False)
    db.add(role)
    await db.commit()
    await db.refresh(role)
    return RoleOut(id=role.id, name=role.name, description=role.description, is_system=role.is_system, user_count=0)


@router.patch("/admin/roles/{role_id}", response_model=RoleOut)
async def update_role(role_id: UUID, body: RoleUpdateRequest, db: AsyncSession = Depends(get_db), _: User = Depends(_super)):
    role = await _load_role(db, role_id)

    if body.name is not None:
        new_name = _normalize_role_name(body.name)
        if new_name != role.name:
            if role.is_system:
                raise HTTPException(
                    400,
                    "The Super Admin role cannot be renamed — it is the one role this application's "
                    "privilege check is explicitly tied to. Only its description can be edited.",
                )
            existing = await db.execute(select(Role).where(func.lower(Role.name) == new_name, Role.id != role_id))
            if existing.scalar_one_or_none():
                raise HTTPException(409, "A role with this name already exists.")
            # Renaming a custom role must keep every existing assignment
            # pointing at the same role, so the rename is propagated to
            # every user/user_roles row currently holding the old name —
            # otherwise those users would silently lose their role.
            await db.execute(update(User).where(User.active_role == role.name).values(active_role=new_name))
            await db.execute(update(UserRole).where(UserRole.role == role.name).values(role=new_name))
            role.name = new_name

    if body.description is not None:
        description = body.description.strip() or None
        if description and len(description) > 255:
            raise HTTPException(400, "Description must be 255 characters or fewer.")
        role.description = description

    await db.commit()
    await db.refresh(role)
    user_count = await _role_user_count(db, role.name)
    return RoleOut(id=role.id, name=role.name, description=role.description, is_system=role.is_system, user_count=user_count)


@router.delete("/admin/roles/{role_id}", status_code=204)
async def delete_role(role_id: UUID, db: AsyncSession = Depends(get_db), _: User = Depends(_super)):
    role = await _load_role(db, role_id)
    if role.is_system:
        raise HTTPException(400, "The Super Admin role cannot be deleted.")

    count = await _role_user_count(db, role.name)
    if count > 0:
        raise HTTPException(
            409,
            f"Cannot delete this role because {count} user{'s' if count != 1 else ''} "
            f"{'are' if count != 1 else 'is'} currently assigned to it. "
            "Reassign those users before deleting the role.",
        )

    await db.delete(role)
    await db.commit()
