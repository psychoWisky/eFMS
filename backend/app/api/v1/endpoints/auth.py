"""Authentication: admin-created users (temporary password + forced first-login
change), two-step login (password then email OTP), admin user management."""
import hashlib, smtplib
import csv, io
from email.mime.text import MIMEText
from datetime import datetime, timezone, timedelta, date
from typing import Optional, List
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.exc import IntegrityError
from pydantic import BaseModel, EmailStr, ValidationError

from app.db.base import get_db
from app.core.security import (
    verify_password, hash_password,
    create_access_token, create_refresh_token, verify_token,
    is_password_policy_compliant, generate_temp_password, PASSWORD_POLICY_MESSAGE,
)
from app.core.config import settings
from app.core.dependencies import get_current_user, require_roles
from app.models.user import User, UserRole, RefreshToken, SystemRole, EFMS_ASSIGNABLE_ROLES
from app.models.efms_extra import OTP
from app.schemas.auth import LoginRequest, TokenResponse, RefreshRequest, UserBrief

router = APIRouter(prefix="/auth", tags=["Authentication"])
_super = require_roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
# Bulk import and delete are explicitly Super-Admin-only (stricter than the
# existing _super, which also admits plain Admin) — reuses the same
# require_roles() mechanism, just with a narrower role set, rather than a
# new authorization system.
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


async def _create_user_record(db: AsyncSession, body: CreateUserRequest) -> User:
    """Core "create one user" logic — role/password-policy/email-uniqueness
    validation, then the actual User + UserRole rows. Shared by the single-
    user endpoint below and the bulk CSV importer, so the two can never drift
    on what counts as a valid new user. Raises HTTPException on any
    validation failure. Flushes (so the caller can read user.id) but does
    NOT commit — callers decide their own commit/rollback boundary (the
    single-user endpoint commits once; the bulk importer commits per row so
    one bad row can't roll back rows that already succeeded)."""
    role_map = {r.value: r for r in SystemRole}
    role = role_map.get(body.role)
    if not role:
        raise HTTPException(400, "Invalid role.")
    if role not in EFMS_ASSIGNABLE_ROLES:
        raise HTTPException(400, "This role cannot be assigned to eFMS users.")
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
    "first_name", "last_name", "email", "mobile", "employee_code",
    "date_of_birth", "designation", "establishment_id", "department_id",
    "role", "is_active", "temp_password",
]
_BULK_REQUIRED_COLUMNS = {"first_name", "last_name", "email", "mobile", "designation", "role"}


@router.get("/admin/users/bulk/sample")
async def download_bulk_user_sample(_: User = Depends(_super_admin_only)):
    """A ready-to-fill CSV template for bulk user creation — same columns
    CreateUserRequest accepts (see _BULK_CSV_COLUMNS), so what validates here
    is exactly what validates on single-user creation. temp_password may be
    left blank; a strong one is auto-generated per row (see bulk_create_users)."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(_BULK_CSV_COLUMNS)
    writer.writerow([
        "John", "Doe", "john.doe@example.com", "9876543210", "EMP001",
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
    status: str  # "created" | "failed"
    error: Optional[str] = None
    temp_password: Optional[str] = None


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
        temp_password = row.get("temp_password") or generate_temp_password()

        try:
            body = CreateUserRequest(
                first_name=row.get("first_name", ""),
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
        results.append(BulkUserRowResult(row=idx, email=email, status="created", temp_password=temp_password))

    return BulkUserUploadResult(total=len(results), created=created_count, failed=len(results) - created_count, results=results)


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
        # Grandfather legacy roles: re-submitting a user's existing role is a
        # no-op regardless of the allow-list, so editing other fields on a
        # legacy-role user never breaks just because their role predates
        # EFMS_ASSIGNABLE_ROLES. Only an actual change is checked against it.
        if role != user.active_role and role not in EFMS_ASSIGNABLE_ROLES:
            raise HTTPException(400, "This role cannot be assigned to eFMS users.")
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


@router.delete("/admin/users/{uid}", status_code=204)
async def delete_user(
    uid: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(_super_admin_only),
):
    """Permanently remove a user — Super Admin only (stricter than every
    other endpoint in this section, which also admits plain Admin). This is
    a real hard delete, not a soft-delete: the app has no
    deleted_at/is_deleted pattern anywhere, and is_active already covers
    "disable without deleting" (see set_user_status above), so a separate
    "Delete" action is expected to actually remove the row.

    Most non-trivial User FKs across the schema (EfmsFile.created_by,
    RouteEntry.from_user_id/to_user_id, FileAttachment.uploaded_by, etc.)
    have no ON DELETE clause, so the database itself refuses to delete a
    user with real eFMS history — that IntegrityError is caught and turned
    into a clear, actionable message rather than a raw 500. Only a user
    with no such history (e.g. a freshly created account) can actually be
    deleted; everyone else must be deactivated instead."""
    if uid == current_user.id:
        raise HTTPException(400, "You cannot delete your own account.")
    user = await _load_user(db, uid)
    try:
        await db.delete(user)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            409,
            "This user cannot be deleted because they have existing activity in the system "
            "(files, attachments, signatures, or other records). Deactivate the user instead.",
        )
