"""Authentication: admin-created users (temporary password + forced first-login
change), two-step login (password then email OTP), admin user management."""
import hashlib, smtplib
from email.mime.text import MIMEText
from datetime import datetime, timezone, timedelta, date
from typing import Optional, List
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from pydantic import BaseModel, EmailStr

from app.db.base import get_db
from app.core.security import (
    verify_password, hash_password,
    create_access_token, create_refresh_token, verify_token,
    is_password_policy_compliant, generate_temp_password, PASSWORD_POLICY_MESSAGE,
)
from app.core.config import settings
from app.core.dependencies import get_current_user, require_roles
from app.models.user import User, UserRole, RefreshToken, SystemRole
from app.models.efms_extra import OTP
from app.schemas.auth import LoginRequest, TokenResponse, RefreshRequest, UserBrief

router = APIRouter(prefix="/auth", tags=["Authentication"])
_super = require_roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)


# ── OTP helpers (login 2FA only — self-registration removed) ─────────────────

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
    )


async def _issue_tokens(user: User, db: AsyncSession) -> TokenResponse:
    access_token = create_access_token(
        subject=str(user.id),
        extra_claims={"role": user.active_role.value if user.active_role else None},
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
    model_config = {"from_attributes": True}

    @classmethod
    def from_user(cls, u: "User") -> "AdminUserOut":
        return cls(
            id=u.id, email=u.email,
            first_name=u.first_name, last_name=u.last_name, full_name=u.full_name,
            mobile=u.mobile, employee_code=u.employee_code,
            date_of_birth=u.date_of_birth.isoformat() if u.date_of_birth else None,
            designation=u.designation,
            establishment_id=u.establishment_id,
            establishment_name=u.establishment.name if u.establishment else None,
            department_id=u.department_id,
            department_name=u.department.name if u.department else None,
            active_role=u.active_role.value if u.active_role else None,
            is_active=u.is_active,
            must_change_password=u.must_change_password,
            can_sign=u.can_sign,
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


async def _set_single_role(db: AsyncSession, user: User, role: SystemRole) -> None:
    """Replace whatever UserRole rows a user has with exactly one, matching
    active_role. Roles here are a single organizational context, not a
    multi-role grant list."""
    existing = await db.execute(select(UserRole).where(UserRole.user_id == user.id))
    for ur in existing.scalars().all():
        await db.delete(ur)
    user.active_role = role
    db.add(UserRole(user_id=user.id, role=role))


@router.get("/admin/users", response_model=List[AdminUserOut])
async def list_admin_users(db: AsyncSession = Depends(get_db), _: User = Depends(_super)):
    result = await db.execute(
        select(User)
        .options(selectinload(User.department), selectinload(User.establishment))
        .order_by(User.created_at.desc())
    )
    return [AdminUserOut.from_user(u) for u in result.scalars().all()]


class CreateUserRequest(BaseModel):
    first_name: str
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


@router.post("/admin/users", status_code=201, response_model=AdminUserOut)
async def create_user(
    body: CreateUserRequest,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(_super),
):
    role_map = {r.value: r for r in SystemRole}
    role = role_map.get(body.role)
    if not role:
        raise HTTPException(400, "Invalid role.")
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
    await db.commit()
    return AdminUserOut.from_user(await _load_user(db, user.id))


class EditUserRequest(BaseModel):
    first_name: Optional[str] = None
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

    if body.email is not None:
        email = body.email.lower().strip()
        if email != user.email:
            existing = await db.execute(select(User).where(User.email == email, User.id != uid))
            if existing.scalar_one_or_none():
                raise HTTPException(409, "An account with this email already exists.")
            user.email = email
    if body.first_name is not None:
        user.first_name = body.first_name.strip()
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
        role_map = {r.value: r for r in SystemRole}
        role = role_map.get(body.role)
        if not role:
            raise HTTPException(400, "Invalid role.")
        await _set_single_role(db, user, role)

    await db.commit()
    return AdminUserOut.from_user(await _load_user(db, uid))


class UserStatusRequest(BaseModel):
    is_active: bool


@router.patch("/admin/users/{uid}/status", response_model=AdminUserOut)
async def set_user_status(
    uid: UUID,
    body: UserStatusRequest,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(_super),
):
    user = await _load_user(db, uid)
    user.is_active = body.is_active
    await db.commit()
    return AdminUserOut.from_user(await _load_user(db, uid))


@router.post("/admin/users/{uid}/reset-password")
async def reset_user_password(
    uid: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(_super),
):
    """Future-proofed reuse of the temporary-password mechanism: generates a
    new temp password and requires the user to change it on next login, same
    as account creation."""
    user = await _load_user(db, uid)
    temp_password = generate_temp_password()
    user.hashed_password = hash_password(temp_password)
    user.must_change_password = True
    await db.commit()
    return {"temp_password": temp_password}
