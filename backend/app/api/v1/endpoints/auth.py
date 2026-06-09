"""Authentication: signup (with OTP), login (password/email-OTP/mobile-OTP), admin user approval."""
import hashlib, random, string, smtplib
from email.mime.text import MIMEText
from datetime import datetime, timezone, timedelta
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
    create_access_token, create_refresh_token, verify_token
)
from app.core.config import settings
from app.core.dependencies import get_current_user, require_roles
from app.models.user import User, UserRole, RefreshToken, SystemRole
from app.models.efms_extra import OTP
from app.schemas.auth import LoginRequest, TokenResponse, RefreshRequest, UserBrief

router = APIRouter(prefix="/auth", tags=["Authentication"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class SignupRequest(BaseModel):
    first_name: str
    last_name: str
    date_of_birth: Optional[str] = None
    designation: str
    employee_code: Optional[str] = None
    email: EmailStr
    mobile: str
    establishment_id: Optional[UUID] = None
    department_id: Optional[UUID] = None
    password: str
    confirm_password: str
    email_otp: str          # OTP verified before signup completes

class OTPRequest(BaseModel):
    target: str             # email or mobile
    otp_type: str = "email" # email | mobile

class OTPVerify(BaseModel):
    target: str
    otp_type: str = "email"
    code: str

class UserApprovalAction(BaseModel):
    approve: bool
    role: Optional[str] = "efms_officer"  # role to assign on approval


# ── OTP helpers ───────────────────────────────────────────────────────────────

def _gen_otp() -> str:
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


# ── Email helper ──────────────────────────────────────────────────────────────

def _send_email_otp(to: str, code: str) -> None:
    from app.core.config import settings
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


# ── Send OTP ──────────────────────────────────────────────────────────────────

@router.post("/otp/send")
async def send_otp(body: OTPRequest, db: AsyncSession = Depends(get_db)):
    target = body.target.lower().strip()
    code = await _create_otp(db, target, body.otp_type)

    if body.otp_type == "email":
        _send_email_otp(target, code)
        return {"message": f"OTP sent to {target}"}
    else:
        # Mobile OTP — fixed 123456, no SMS provider
        return {"message": f"OTP sent to {target}", "dev_otp": code}


@router.post("/otp/verify")
async def verify_otp_endpoint(body: OTPVerify, db: AsyncSession = Depends(get_db)):
    ok = await _verify_otp(db, body.target.lower().strip(), body.otp_type, body.code)
    if not ok:
        raise HTTPException(status_code=400, detail="Invalid or expired OTP.")
    return {"verified": True}


# ── Signup ────────────────────────────────────────────────────────────────────

@router.post("/signup", status_code=201)
async def signup(body: SignupRequest, db: AsyncSession = Depends(get_db)):
    if body.password != body.confirm_password:
        raise HTTPException(status_code=400, detail="Passwords do not match.")

    # Verify email OTP before creating account
    ok = await _verify_otp(db, body.email.lower().strip(), "email", body.email_otp)
    if not ok:
        raise HTTPException(status_code=400, detail="Invalid or expired email OTP. Please verify your email first.")

    # Check email not already registered
    existing = await db.execute(select(User).where(User.email == body.email.lower().strip()))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="An account with this email already exists.")

    user = User(
        email=body.email.lower().strip(),
        hashed_password=hash_password(body.password),
        first_name=body.first_name.strip(),
        last_name=body.last_name.strip(),
        mobile=body.mobile,
        designation=body.designation,
        employee_code=body.employee_code,
        department_id=body.department_id,
        establishment_id=body.establishment_id,
        is_active=True,
        kyc_completed=True,
    )
    db.add(user)
    await db.commit()
    return {"message": "Registration submitted. Your account is pending admin approval."}


# ── Login (password) ──────────────────────────────────────────────────────────

def build_user_brief(user: User) -> UserBrief:
    return UserBrief(
        id=str(user.id),
        email=user.email,
        full_name=user.full_name,
        active_role=user.active_role,
        kyc_completed=user.kyc_completed,
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


@router.post("/login", response_model=TokenResponse)
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(User).options(selectinload(User.roles)).where(User.email == payload.email)
    )
    user = result.scalar_one_or_none()

    if not user or not user.hashed_password or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Incorrect email or password.")

    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Your account has been deactivated.")

    resp = await _issue_tokens(user, db)
    await db.commit()
    return resp


# ── Login with email OTP ──────────────────────────────────────────────────────

class OTPLoginRequest(BaseModel):
    email: str
    otp: str

@router.post("/login/otp", response_model=TokenResponse)
async def login_otp(payload: OTPLoginRequest, db: AsyncSession = Depends(get_db)):
    ok = await _verify_otp(db, payload.email.lower().strip(), "email", payload.otp)
    if not ok:
        raise HTTPException(status_code=401, detail="Invalid or expired OTP.")

    result = await db.execute(
        select(User).options(selectinload(User.roles)).where(User.email == payload.email.lower().strip())
    )
    user = result.scalar_one_or_none()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="Account not found or deactivated.")

    resp = await _issue_tokens(user, db)
    await db.commit()
    return resp


# ── Login with mobile OTP ─────────────────────────────────────────────────────

class MobileOTPLoginRequest(BaseModel):
    mobile: str
    otp: str

@router.post("/login/mobile-otp", response_model=TokenResponse)
async def login_mobile_otp(payload: MobileOTPLoginRequest, db: AsyncSession = Depends(get_db)):
    mobile = payload.mobile.strip()
    ok = await _verify_otp(db, mobile, "mobile", payload.otp)
    if not ok:
        raise HTTPException(status_code=401, detail="Invalid or expired OTP.")

    result = await db.execute(
        select(User).options(selectinload(User.roles)).where(User.mobile == mobile, User.is_active == True)
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="No account found with this mobile number.")

    resp = await _issue_tokens(user, db)
    await db.commit()
    return resp


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


# ── Admin: user approval ──────────────────────────────────────────────────────

class PendingUserOut(BaseModel):
    id: UUID; email: str; first_name: Optional[str]; last_name: Optional[str]
    designation: Optional[str]; employee_code: Optional[str]; mobile: Optional[str]
    department_name: Optional[str] = None
    active_role: Optional[str] = None
    model_config = {"from_attributes": True}

    @classmethod
    def from_user(cls, u: "User") -> "PendingUserOut":
        return cls(
            id=u.id, email=u.email,
            first_name=u.first_name, last_name=u.last_name,
            designation=u.designation, employee_code=u.employee_code,
            mobile=u.mobile,
            department_name=u.department.name if u.department else None,
            active_role=u.active_role.value if u.active_role else None,
        )


@router.get("/admin/pending-users", response_model=List[PendingUserOut])
async def pending_users(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN))
):
    result = await db.execute(
        select(User)
        .options(selectinload(User.department))
        .where(User.active_role == None, User.is_active == True)
        .order_by(User.created_at)
    )
    return [PendingUserOut.from_user(u) for u in result.scalars().all()]


@router.post("/admin/users/{uid}/approve")
async def approve_user(
    uid: UUID,
    body: UserApprovalAction,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN))
):
    user = await db.get(User, uid)
    if not user:
        raise HTTPException(404, "User not found.")

    if body.approve:
        role_map = {r.value: r for r in SystemRole}
        role = role_map.get(body.role, SystemRole.EFMS_OFFICER)
        user.active_role = role
        ur = UserRole(user_id=user.id, role=role)
        db.add(ur)
        await db.commit()
        return {"message": f"User approved with role {role.value}."}
    else:
        user.is_active = False
        await db.commit()
        return {"message": "User rejected."}


@router.get("/admin/all-users", response_model=List[PendingUserOut])
async def all_users(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN))
):
    result = await db.execute(
        select(User)
        .options(selectinload(User.department))
        .order_by(User.created_at.desc())
    )
    return [PendingUserOut.from_user(u) for u in result.scalars().all()]


@router.delete("/admin/users/{uid}", status_code=204)
async def remove_user(
    uid: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN))
):
    user = await db.get(User, uid)
    if not user:
        raise HTTPException(404, "User not found.")
    user.is_active = False
    await db.commit()
