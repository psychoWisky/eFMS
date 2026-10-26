"""FOC — Fixation of Ceiling. See app/models/foc.py for the workflow.

Endpoints (all under /api/v1/foc, all need a signed-in, non-retired user):

  Who am I / lookups
    GET    /me                          what the caller may do in FOC
    GET    /financial-years             choices for the FY dropdown
    GET    /ddos                        DDOs the in-charge can send to

  Super Admin set-up
    GET    /projects        POST /projects        PATCH/DELETE /projects/{id}
    GET    /officers        POST /officers        DELETE /officers/{id}
    GET    /sheets          POST /sheets          PATCH/DELETE /sheets/{id}

  In-charge
    GET    /sheets/mine
    PUT    /sheets/{id}/entries                    amount required, sanction order no, purpose, remark
    POST   /sheets/{id}/lines/{line_id}/document   upload the sanction document
    DELETE /sheets/{id}/lines/{line_id}/document
    POST   /sheets/{id}/submit                     certify and send to a DDO

  Officers (the current holder)
    POST   /sheets/{id}/approve | reject | forward

  Everyone involved
    GET    /docket                                 what is waiting for / has come back to me
    GET    /history                                sheets I have acted on
    GET    /sheets/{id}                            full details + trail
    GET    /sheets/{id}/lines/{line_id}/document   view the sanction document
    GET    /sheets/{id}/pdf                        letterhead PDF (approved sheets only)
"""
import os
import re
import uuid as _uuid
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from html import escape as _esc
from typing import Optional
from uuid import UUID
from zoneinfo import ZoneInfo

import aiofiles
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.core.dependencies import forbid_retired, require_roles
from app.db.base import get_db
from app.models.admin import Notification
from app.models.foc import (
    FIXED_ROLES, FOC_CHAIN, ROLE_TITLES, FocLine, FocMovement, FocOfficer,
    FocOfficerRole, FocProject, FocRoleLink, FocSheet, FocStatus,
)
from app.models.organization import Department, Establishment
from app.models.user import Role, SystemRole, User, UserRole
from app.utils.letterhead import LETTERHEAD_CSS, letterhead_html, letterhead_logo_html

router = APIRouter(prefix="/foc", tags=["FOC — Fixation of Ceiling"])
_super = require_roles(SystemRole.SUPER_ADMIN)
_user = forbid_retired

MAX_LINES = 100
MONEY_LIMIT = Decimal("99999999999999.99")
DOC_EXTENSIONS = {"pdf", "jpg", "jpeg", "png", "doc", "docx"}
FY_PATTERN = re.compile(r"^(\d{4})-(\d{4})$")


def _doc_dir() -> str:
    """Sanction documents are kept OUTSIDE the public /uploads mount — they
    are only ever served through the permission-checked endpoint."""
    base = os.path.dirname(os.path.abspath(settings.UPLOAD_DIR))
    path = os.path.join(base, "foc_documents")
    os.makedirs(path, exist_ok=True)
    return path


# ── Small helpers ────────────────────────────────────────────────────────────

def _money(value, field: str, line_no: Optional[int] = None) -> Decimal:
    where = f"Line {line_no}: " if line_no else ""
    try:
        d = Decimal(str(value if value not in (None, "") else "0")).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        raise HTTPException(400, f"{where}{field} must be a number.")
    if d < 0:
        raise HTTPException(400, f"{where}{field} cannot be negative.")
    if d > MONEY_LIMIT:
        raise HTTPException(400, f"{where}{field} is too large.")
    return d


def _fmt(d: Optional[Decimal]) -> str:
    return f"{(d or Decimal('0')):.2f}"


def _clean(text_value: Optional[str], limit: int) -> Optional[str]:
    v = (text_value or "").strip()
    if len(v) > limit:
        raise HTTPException(400, f"Text is too long (limit {limit} characters).")
    return v or None


def _check_fy(fy: str) -> str:
    m = FY_PATTERN.match((fy or "").strip())
    if not m or int(m.group(2)) != int(m.group(1)) + 1:
        raise HTTPException(400, "Financial year must look like 2025-2026.")
    return fy.strip()


def _person(u: Optional[User]) -> Optional[dict]:
    if not u:
        return None
    return {"id": str(u.id), "full_name": u.full_name, "designation": u.designation, "email": u.email}


def _person_label(u: Optional[User]) -> str:
    if not u:
        return "—"
    return f"{u.full_name} ({u.designation})" if u.designation else u.full_name


_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven",
         "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"]
_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"]


def _two(n: int) -> str:
    return _ONES[n] if n < 20 else (_TENS[n // 10] + (" " + _ONES[n % 10] if n % 10 else ""))


def _three(n: int) -> str:
    h, r = divmod(n, 100)
    return " ".join(p for p in ((_ONES[h] + " Hundred") if h else "", _two(r) if r else "") if p)


def rupees_in_words(amount: Decimal) -> str:
    """Indian numbering: 1513842 → "Fifteen Lakh Thirteen Thousand Eight
    Hundred Forty Two Rupees Only" (paise added when present)."""
    amount = (amount or Decimal("0")).quantize(Decimal("0.01"))
    rupees = int(amount)
    paise = int((amount - rupees) * 100)
    if rupees == 0 and paise == 0:
        return "Zero Rupees Only"
    parts = []
    crore, rest = divmod(rupees, 10_000_000)
    lakh, rest = divmod(rest, 100_000)
    thousand, rest = divmod(rest, 1000)
    if crore:
        parts.append((rupees_in_words(Decimal(crore)).replace(" Rupees Only", "") if crore > 999 else _three(crore)) + " Crore")
    if lakh:
        parts.append(_two(lakh) + " Lakh")
    if thousand:
        parts.append(_two(thousand) + " Thousand")
    if rest:
        parts.append(_three(rest))
    words = " ".join(parts)
    out = f"{words} Rupees" if words else ""
    if paise:
        out = f"{out} and {_two(paise)} Paise" if out else f"{_two(paise)} Paise"
    return out + " Only"


# ── Officers ─────────────────────────────────────────────────────────────────
# DDOs are chosen by the Super Admin (foc_officers). The Assistant
# Comptroller, Finance Officer and Vice Chancellor are whoever holds the
# linked eFMS role right now — so a hand-over in eFMS carries over to FOC,
# including FOCs already waiting at that stage.

# eFMS role names recognised without an explicit link (spaces, "_" and case ignored).
_ROLE_NAME_GUESSES = {
    FocOfficerRole.ASSISTANT_COMPTROLLER: {"assistantcomptroller", "asstcomptroller"},
    FocOfficerRole.FINANCE_OFFICER: {"financeofficer"},
    FocOfficerRole.VICE_CHANCELLOR: {"vicechancellor"},
}


def _squash(name: str) -> str:
    return re.sub(r"[^a-z]", "", (name or "").lower())


async def _linked_efms_role(db: AsyncSession, role: FocOfficerRole) -> tuple[Optional[Role], bool]:
    """(eFMS role, chosen explicitly by the Super Admin?)"""
    link = await db.get(FocRoleLink, role.value)
    if link:
        return (await db.get(Role, link.efms_role_id) if link.efms_role_id else None), True
    for r in (await db.execute(select(Role))).scalars().all():
        if _squash(r.name) in _ROLE_NAME_GUESSES[role]:
            return r, False
    return None, False


async def _role_holders(db: AsyncSession, role_name: str) -> list[User]:
    rows = (await db.execute(
        select(User).join(UserRole, UserRole.user_id == User.id)
        .where(UserRole.role == role_name, User.is_active == True, User.origin_user_id.is_(None))  # noqa: E712
    )).scalars().unique().all()
    return [u for u in rows if not u.is_retired]


class _Fixed:
    def __init__(self, role: FocOfficerRole, efms_role: Optional[Role], explicit: bool, holders: list[User]):
        self.role, self.efms_role, self.explicit, self.holders = role, efms_role, explicit, holders

    @property
    def holder(self) -> Optional[User]:
        return self.holders[0] if len(self.holders) == 1 else None

    @property
    def problem(self) -> Optional[str]:
        title = ROLE_TITLES[self.role]
        if not self.efms_role:
            return f"No eFMS role is linked to the {title}. Choose one in FOC Setup → Officers."
        if not self.holders:
            return f"Nobody holds the eFMS role “{self.efms_role.name}” ({title}) yet. Assign it in eFMS User Management."
        if len(self.holders) > 1:
            names = ", ".join(u.full_name for u in self.holders)
            return f"More than one person holds the eFMS role “{self.efms_role.name}” ({names}). FOC needs exactly one {title}."
        return None


async def _fixed(db: AsyncSession, role: FocOfficerRole) -> _Fixed:
    efms_role, explicit = await _linked_efms_role(db, role)
    holders = await _role_holders(db, efms_role.name) if efms_role else []
    return _Fixed(role, efms_role, explicit, holders)


async def _officer_roles(db: AsyncSession, user_id: UUID) -> set[str]:
    roles = set((await db.execute(select(FocOfficer.role).where(FocOfficer.user_id == user_id))).scalars().all())
    for r in FIXED_ROLES:
        f = await _fixed(db, r)
        if f.holder and f.holder.id == user_id:
            roles.add(r.value)
    return roles


async def _handles(db: AsyncSession, sheet: FocSheet, user: User) -> bool:
    """Is this pending FOC waiting for this person right now?"""
    if sheet.status != FocStatus.PENDING.value or not sheet.stage:
        return False
    if sheet.stage == FocOfficerRole.DDO.value:
        is_ddo = (await db.execute(select(FocOfficer.id).where(
            FocOfficer.role == FocOfficerRole.DDO.value, FocOfficer.user_id == user.id))).first()
        return sheet.holder_id == user.id and bool(is_ddo)
    f = await _fixed(db, FocOfficerRole(sheet.stage))
    return bool(f.holder and f.holder.id == user.id)


def _notify(db: AsyncSession, user_id: Optional[UUID], title: str, message: str) -> None:
    if user_id:
        db.add(Notification(user_id=user_id, title=title, message=message, type="foc"))


def _assignable(u: Optional[User], what: str) -> User:
    if not u or u.is_project_profile:
        raise HTTPException(400, f"Choose a real person for the {what}.")
    if not u.is_active or u.is_retired:
        raise HTTPException(400, f"{u.full_name} is not active and cannot be the {what}.")
    return u


async def _load_sheet(db: AsyncSession, sheet_id: UUID, lock: bool = False) -> FocSheet:
    q = (
        select(FocSheet)
        .options(
            selectinload(FocSheet.project).selectinload(FocProject.establishment),
            selectinload(FocSheet.project).selectinload(FocProject.department),
            selectinload(FocSheet.project).selectinload(FocProject.incharge),
            selectinload(FocSheet.incharge),
            selectinload(FocSheet.holder),
            selectinload(FocSheet.lines),
            selectinload(FocSheet.movements).selectinload(FocMovement.from_user),
            selectinload(FocSheet.movements).selectinload(FocMovement.to_user),
        )
        .where(FocSheet.id == sheet_id)
        .execution_options(populate_existing=True)
    )
    if lock:
        q = q.with_for_update(of=FocSheet)
    sheet = (await db.execute(q)).scalar_one_or_none()
    if not sheet:
        raise HTTPException(404, "FOC not found.")
    return sheet


async def _can_view(db: AsyncSession, sheet: FocSheet, user: User) -> bool:
    if user.is_super_admin or sheet.incharge_id == user.id or sheet.holder_id == user.id:
        return True
    if any(m.from_user_id == user.id or m.to_user_id == user.id for m in sheet.movements):
        return True
    return await _handles(db, sheet, user)


def _editable_by_incharge(sheet: FocSheet, user: User) -> bool:
    return sheet.incharge_id == user.id and sheet.status in (FocStatus.DRAFT.value, FocStatus.REJECTED.value)


def _stage_title(stage: Optional[str]) -> Optional[str]:
    try:
        return ROLE_TITLES[FocOfficerRole(stage)] if stage else None
    except ValueError:
        return stage


def _status_label(sheet: FocSheet) -> str:
    if sheet.status == FocStatus.PENDING.value:
        return f"With {_stage_title(sheet.stage)}"
    if sheet.status == FocStatus.APPROVED.value:
        return f"Approved by {_stage_title(sheet.decided_stage)}"
    if sheet.status == FocStatus.REJECTED.value:
        return f"Returned by {_stage_title(sheet.decided_stage)}"
    return "Draft"


def _project_out(p: FocProject) -> dict:
    return {
        "id": str(p.id), "name": p.name, "funded_by": p.funded_by, "funding_agency": p.funding_agency,
        "establishment_id": str(p.establishment_id) if p.establishment_id else None,
        "establishment_name": p.establishment.name if p.establishment else None,
        "department_id": str(p.department_id) if p.department_id else None,
        "department_name": p.department.name if p.department else None,
        "incharge": _person(p.incharge), "project_type": p.project_type,
        "bank_account_holder": p.bank_account_holder, "bank_name": p.bank_name, "bank_account_no": p.bank_account_no,
        "fund_instrument_no": p.fund_instrument_no,
        "fund_received_date": p.fund_received_date.isoformat() if p.fund_received_date else None,
        "fund_sanction_remittance_no": p.fund_sanction_remittance_no,
        "is_active": p.is_active,
    }


def _line_out(line: FocLine, sheet_id: UUID) -> dict:
    return {
        "id": str(line.id), "sl_no": line.sl_no, "sub_head": line.sub_head,
        "sanctioned_fund": _fmt(line.sanctioned_fund), "available_fund": _fmt(line.available_fund),
        "amount_required": _fmt(line.amount_required),
        "sanction_order_no": line.sanction_order_no, "purpose": line.purpose, "remark": line.remark,
        "document": {
            "name": line.document_original_name, "size": line.document_size, "mime": line.document_mime,
            "url": f"/api/v1/foc/sheets/{sheet_id}/lines/{line.id}/document",
        } if line.document_stored_name else None,
    }


async def _sheet_out(db: AsyncSession, sheet: FocSheet, user: User) -> dict:
    total = sum((ln.amount_required or Decimal("0")) for ln in sheet.lines)
    is_holder = await _handles(db, sheet, user)
    holder = sheet.holder
    if sheet.status == FocStatus.PENDING.value and sheet.stage and sheet.stage != FocOfficerRole.DDO.value:
        # The fixed offices follow the eFMS role — show who holds it now.
        holder = (await _fixed(db, FocOfficerRole(sheet.stage))).holder or holder
    stage_index = FOC_CHAIN.index(FocOfficerRole(sheet.stage)) if sheet.stage else None
    next_role = FOC_CHAIN[stage_index + 1] if stage_index is not None and stage_index + 1 < len(FOC_CHAIN) else None
    return {
        "id": str(sheet.id), "number": sheet.number, "name": sheet.name, "financial_year": sheet.financial_year,
        "status": sheet.status, "status_label": _status_label(sheet),
        "stage": sheet.stage, "stage_title": _stage_title(sheet.stage),
        "project": _project_out(sheet.project),
        "incharge": _person(sheet.incharge), "holder": _person(holder) if sheet.status == FocStatus.PENDING.value else None,
        "certified": sheet.certified,
        "created_at": sheet.created_at.isoformat() if sheet.created_at else None,
        "submitted_at": sheet.submitted_at.isoformat() if sheet.submitted_at else None,
        "decided_stage": sheet.decided_stage, "decided_stage_title": _stage_title(sheet.decided_stage),
        "decided_at": sheet.decided_at.isoformat() if sheet.decided_at else None,
        "lines": [_line_out(ln, sheet.id) for ln in sheet.lines],
        "total_required": _fmt(total),
        "total_required_words": rupees_in_words(total),
        "movements": [
            {
                "action": m.action, "remark": m.remark,
                "from_user": _person(m.from_user), "from_stage": m.from_stage, "from_stage_title": _stage_title(m.from_stage) or "In-charge",
                "to_user": _person(m.to_user), "to_stage": m.to_stage, "to_stage_title": _stage_title(m.to_stage) or ("In-charge" if m.action in ("approved", "rejected") else None),
                "created_at": m.created_at.isoformat() if m.created_at else None,
            }
            for m in sheet.movements
        ],
        # what the caller may do right now
        "can_edit": _editable_by_incharge(sheet, user),
        "can_submit": _editable_by_incharge(sheet, user),
        "can_act": is_holder,
        "can_forward": is_holder and next_role is not None,
        "forward_to_title": ROLE_TITLES[next_role] if (is_holder and next_role) else None,
        "can_download": sheet.status == FocStatus.APPROVED.value,
    }


# ── Who am I / lookups ───────────────────────────────────────────────────────

@router.get("/me")
async def foc_me(db: AsyncSession = Depends(get_db), user: User = Depends(_user)):
    roles = await _officer_roles(db, user.id)
    is_incharge = (
        (await db.execute(select(FocSheet.id).where(FocSheet.incharge_id == user.id).limit(1))).first() is not None
        or (await db.execute(select(FocProject.id).where(FocProject.incharge_id == user.id).limit(1))).first() is not None
    )
    involved = is_incharge or bool(roles)
    return {
        "is_super_admin": user.is_super_admin,
        "is_incharge": is_incharge,
        "officer_roles": sorted(roles),
        "officer_titles": [ROLE_TITLES[FocOfficerRole(r)] for r in FOC_CHAIN if r.value in roles],
        # The Super Admin sets FOC up; a docket is only for those who take part.
        "has_docket": involved,
        "has_access": user.is_super_admin or involved,
    }


@router.get("/financial-years")
async def financial_years(user: User = Depends(_user)):
    today = date.today()
    start = today.year if today.month >= 4 else today.year - 1   # Indian FY starts 1 April
    years = [f"{y}-{y + 1}" for y in range(start + 1, 2019, -1)]
    return {"current": f"{start}-{start + 1}", "years": years}


@router.get("/ddos")
async def list_ddos(db: AsyncSession = Depends(get_db), user: User = Depends(_user)):
    rows = (await db.execute(
        select(FocOfficer).options(selectinload(FocOfficer.user)).where(FocOfficer.role == FocOfficerRole.DDO.value)
    )).scalars().all()
    people = [r.user for r in rows if r.user and r.user.is_active and not r.user.is_retired and r.user.id != user.id]
    return sorted((_person(p) for p in people), key=lambda p: p["full_name"].lower())


# ── Super Admin: projects ────────────────────────────────────────────────────

class ProjectIn(BaseModel):
    name: Optional[str] = None
    funded_by: Optional[str] = None
    funding_agency: Optional[str] = None
    establishment_id: Optional[UUID] = None
    department_id: Optional[UUID] = None
    incharge_id: Optional[UUID] = None
    project_type: Optional[str] = None
    bank_account_holder: Optional[str] = None
    bank_name: Optional[str] = None
    bank_account_no: Optional[str] = None
    fund_instrument_no: Optional[str] = None
    fund_received_date: Optional[date] = None
    fund_sanction_remittance_no: Optional[str] = None
    is_active: Optional[bool] = None


_PROJECT_TEXT = {
    "funded_by": 200, "funding_agency": 200, "project_type": 100,
    "bank_account_holder": 200, "bank_name": 200, "bank_account_no": 60,
    "fund_instrument_no": 200, "fund_sanction_remittance_no": 200,
}


async def _apply_project(db: AsyncSession, p: FocProject, body: ProjectIn, creating: bool) -> None:
    sent = body.model_fields_set
    if creating or "name" in sent:
        name = _clean(body.name, 300)
        if not name:
            raise HTTPException(400, "Enter the project name.")
        p.name = name
    for field, limit in _PROJECT_TEXT.items():
        if field in sent:
            setattr(p, field, _clean(getattr(body, field), limit))
    if "fund_received_date" in sent:
        p.fund_received_date = body.fund_received_date
    if "is_active" in sent and body.is_active is not None:
        p.is_active = body.is_active
    if "establishment_id" in sent:
        if body.establishment_id and not await db.get(Establishment, body.establishment_id):
            raise HTTPException(400, "Establishment not found.")
        p.establishment_id = body.establishment_id
        if "department_id" not in sent:
            p.department_id = None
    if "department_id" in sent:
        if body.department_id:
            dept = await db.get(Department, body.department_id)
            if not dept:
                raise HTTPException(400, "Department not found.")
            if p.establishment_id and dept.establishment_id and dept.establishment_id != p.establishment_id:
                raise HTTPException(400, "That department belongs to a different establishment.")
        p.department_id = body.department_id
    if "incharge_id" in sent and body.incharge_id != p.incharge_id:
        new = _assignable(await db.get(User, body.incharge_id), "FOC in-charge") if body.incharge_id else None
        p.incharge_id = new.id if new else None
        if new and p.id:
            # FOCs still with the in-charge (draft / returned) move to the new
            # one; FOCs already sent or approved keep who sent them.
            moved = (await db.execute(select(FocSheet).where(
                FocSheet.project_id == p.id, FocSheet.status.in_([FocStatus.DRAFT.value, FocStatus.REJECTED.value]),
            ))).scalars().all()
            for sh in moved:
                sh.incharge_id = new.id
            _notify(db, new.id, "FOC project assigned to you",
                    f"You are now the FOC in-charge of “{p.name}”" + (f" ({len(moved)} FOC{'s' if len(moved) != 1 else ''} to fill in)." if moved else "."))


async def _project_with_org(db: AsyncSession, pid: UUID) -> FocProject:
    p = (await db.execute(
        select(FocProject).options(selectinload(FocProject.establishment), selectinload(FocProject.department),
                                   selectinload(FocProject.incharge))
        .where(FocProject.id == pid).execution_options(populate_existing=True)
    )).scalar_one_or_none()
    if not p:
        raise HTTPException(404, "Project not found.")
    return p


@router.get("/projects")
async def list_projects(db: AsyncSession = Depends(get_db), _: User = Depends(_super)):
    rows = (await db.execute(
        select(FocProject).options(selectinload(FocProject.establishment), selectinload(FocProject.department),
                                   selectinload(FocProject.incharge))
        .order_by(FocProject.is_active.desc(), FocProject.name)
    )).scalars().all()
    return [_project_out(p) for p in rows]


@router.post("/projects", status_code=201)
async def create_project(body: ProjectIn, db: AsyncSession = Depends(get_db), admin: User = Depends(_super)):
    p = FocProject(created_by=admin.id, is_active=True)
    await _apply_project(db, p, body, creating=True)
    db.add(p)
    await db.commit()
    return _project_out(await _project_with_org(db, p.id))


@router.patch("/projects/{pid}")
async def update_project(pid: UUID, body: ProjectIn, db: AsyncSession = Depends(get_db), _: User = Depends(_super)):
    p = await _project_with_org(db, pid)
    await _apply_project(db, p, body, creating=False)
    await db.commit()
    return _project_out(await _project_with_org(db, pid))


@router.delete("/projects/{pid}", status_code=204)
async def delete_project(pid: UUID, db: AsyncSession = Depends(get_db), _: User = Depends(_super)):
    p = await db.get(FocProject, pid)
    if not p:
        raise HTTPException(404, "Project not found.")
    n = len((await db.execute(select(FocSheet.id).where(FocSheet.project_id == pid))).all())
    if n:
        raise HTTPException(409, f"Cannot delete this project — {n} FOC{'s' if n != 1 else ''} use it. "
                                 "You can mark it inactive instead.")
    await db.delete(p)
    await db.commit()


# ── Super Admin: officers ────────────────────────────────────────────────────

class DdoIn(BaseModel):
    user_id: UUID


class FixedLinkIn(BaseModel):
    efms_role_id: Optional[UUID] = None


async def _pending_held(db: AsyncSession, user_id: UUID, role: str) -> int:
    return len((await db.execute(select(FocSheet.id).where(
        FocSheet.status == FocStatus.PENDING.value, FocSheet.holder_id == user_id, FocSheet.stage == role,
    ))).all())


async def _fixed_out(db: AsyncSession, role: FocOfficerRole) -> dict:
    f = await _fixed(db, role)
    return {
        "role": role.value, "role_title": ROLE_TITLES[role],
        "efms_role": {"id": str(f.efms_role.id), "name": f.efms_role.name} if f.efms_role else None,
        "chosen": f.explicit,
        "holders": [_person(u) for u in f.holders],
        "holder": _person(f.holder),
        "problem": f.problem,
    }


@router.get("/officers")
async def list_officers(db: AsyncSession = Depends(get_db), _: User = Depends(_super)):
    rows = (await db.execute(select(FocOfficer).options(selectinload(FocOfficer.user))
                             .where(FocOfficer.role == FocOfficerRole.DDO.value))).scalars().all()
    rows = sorted(rows, key=lambda o: (o.user.full_name if o.user else "").lower())
    return {
        "ddos": [{"id": str(o.id), "user": _person(o.user)} for o in rows],
        "fixed": [await _fixed_out(db, r) for r in FOC_CHAIN if r in FIXED_ROLES],
    }


@router.get("/efms-roles")
async def efms_roles(db: AsyncSession = Depends(get_db), _: User = Depends(_super)):
    rows = (await db.execute(select(Role).where(Role.name != SystemRole.SUPER_ADMIN.value).order_by(Role.name))).scalars().all()
    return [{"id": str(r.id), "name": r.name, "description": r.description} for r in rows]


@router.post("/officers", status_code=201)
async def add_ddo(body: DdoIn, db: AsyncSession = Depends(get_db), _: User = Depends(_super)):
    u = _assignable(await db.get(User, body.user_id), "DDO")
    role = FocOfficerRole.DDO.value
    exists = (await db.execute(select(FocOfficer).where(FocOfficer.role == role, FocOfficer.user_id == u.id))).scalar_one_or_none()
    if exists:
        return {"id": str(exists.id), "role": role}
    o = FocOfficer(role=role, user_id=u.id)
    db.add(o)
    await db.commit()
    return {"id": str(o.id), "role": role}


@router.put("/officers/fixed/{role}")
async def link_fixed_role(role: FocOfficerRole, body: FixedLinkIn, db: AsyncSession = Depends(get_db), _: User = Depends(_super)):
    """Choose which eFMS role is the Assistant Comptroller / Finance Officer /
    Vice Chancellor. FOCs already waiting at that stage go to the new holder."""
    if role not in FIXED_ROLES:
        raise HTTPException(400, "DDOs are added person by person.")
    if body.efms_role_id:
        r = await db.get(Role, body.efms_role_id)
        if not r or r.name == SystemRole.SUPER_ADMIN.value:
            raise HTTPException(400, "Choose one of the eFMS roles.")
    link = await db.get(FocRoleLink, role.value)
    if link:
        link.efms_role_id = body.efms_role_id
    else:
        db.add(FocRoleLink(role=role.value, efms_role_id=body.efms_role_id))
    await db.commit()
    return await _fixed_out(db, role)


@router.delete("/officers/{oid}", status_code=204)
async def remove_officer(oid: UUID, db: AsyncSession = Depends(get_db), _: User = Depends(_super)):
    o = (await db.execute(select(FocOfficer).options(selectinload(FocOfficer.user)).where(FocOfficer.id == oid))).scalar_one_or_none()
    if not o:
        raise HTTPException(404, "DDO not found.")
    waiting = await _pending_held(db, o.user_id, o.role)
    if waiting:
        raise HTTPException(409, f"{o.user.full_name} still has {waiting} FOC{'s' if waiting != 1 else ''} waiting as "
                                 f"DDO. They must be dealt with first.")
    await db.delete(o)
    await db.commit()


# ── Super Admin: sheets ──────────────────────────────────────────────────────

class LineIn(BaseModel):
    id: Optional[UUID] = None
    sub_head: str
    sanctioned_fund: Decimal | float | str
    available_fund: Decimal | float | str


class SheetCreate(BaseModel):
    project_id: UUID
    financial_year: str
    name: str
    lines: list[LineIn] = Field(default_factory=list)


class SheetUpdate(BaseModel):
    financial_year: Optional[str] = None
    name: Optional[str] = None
    lines: Optional[list[LineIn]] = None


def _checked_lines(lines: list[LineIn]) -> list[tuple[LineIn, str, Decimal, Decimal]]:
    if not lines:
        raise HTTPException(400, "Add at least one budget line (sub head).")
    if len(lines) > MAX_LINES:
        raise HTTPException(400, f"An FOC can have at most {MAX_LINES} lines.")
    out = []
    for i, ln in enumerate(lines, start=1):
        sub = _clean(ln.sub_head, 300)
        if not sub:
            raise HTTPException(400, f"Line {i}: enter the sub head.")
        sanctioned = _money(ln.sanctioned_fund, "Sanctioned fund", i)
        available = _money(ln.available_fund, "Available fund", i)
        if available > sanctioned:
            raise HTTPException(400, f"Line {i}: available fund cannot be more than the sanctioned fund.")
        out.append((ln, sub, sanctioned, available))
    return out


async def _duplicate_check(db: AsyncSession, project_id: UUID, fy: str, name: str, exclude: Optional[UUID] = None) -> None:
    q = select(FocSheet.id).where(FocSheet.project_id == project_id, FocSheet.financial_year == fy, FocSheet.name == name)
    if exclude:
        q = q.where(FocSheet.id != exclude)
    if (await db.execute(q)).first():
        raise HTTPException(409, f"This project already has an FOC named “{name}” for {fy}.")


def _delete_doc_file(line: FocLine) -> None:
    if line.document_stored_name:
        try:
            os.remove(os.path.join(_doc_dir(), line.document_stored_name))
        except OSError:
            pass


@router.get("/sheets")
async def list_all_sheets(
    status: Optional[FocStatus] = Query(None), financial_year: Optional[str] = Query(None),
    project_id: Optional[UUID] = Query(None),
    db: AsyncSession = Depends(get_db), _: User = Depends(_super),
):
    q = select(FocSheet).options(
        selectinload(FocSheet.project).selectinload(FocProject.establishment),
        selectinload(FocSheet.project).selectinload(FocProject.department),
        selectinload(FocSheet.incharge), selectinload(FocSheet.holder), selectinload(FocSheet.lines),
    ).order_by(FocSheet.number.desc())
    if status:
        q = q.where(FocSheet.status == status.value)
    if financial_year:
        q = q.where(FocSheet.financial_year == financial_year)
    if project_id:
        q = q.where(FocSheet.project_id == project_id)
    return [_summary(s) for s in (await db.execute(q)).scalars().all()]


def _summary(s: FocSheet, dispatched_by: Optional[User] = None, dispatched_at: Optional[datetime] = None, box: Optional[str] = None) -> dict:
    total = sum((ln.amount_required or Decimal("0")) for ln in s.lines)
    return {
        "id": str(s.id), "number": s.number, "name": s.name, "financial_year": s.financial_year,
        "project_name": s.project.name if s.project else None,
        "establishment_name": s.project.establishment.name if s.project and s.project.establishment else None,
        "department_name": s.project.department.name if s.project and s.project.department else None,
        "incharge": _person(s.incharge),
        "status": s.status, "status_label": _status_label(s), "stage": s.stage, "stage_title": _stage_title(s.stage),
        "holder": _person(s.holder) if s.status == FocStatus.PENDING.value else None,
        "total_required": _fmt(total),
        "submitted_at": s.submitted_at.isoformat() if s.submitted_at else None,
        "updated_at": s.updated_at.isoformat() if s.updated_at else None,
        "dispatched_by": _person(dispatched_by), "dispatched_at": dispatched_at.isoformat() if dispatched_at else None,
        "box": box,
    }


@router.post("/sheets", status_code=201)
async def create_sheet(body: SheetCreate, db: AsyncSession = Depends(get_db), admin: User = Depends(_super)):
    project = await db.get(FocProject, body.project_id)
    if not project:
        raise HTTPException(400, "Project not found.")
    if not project.is_active:
        raise HTTPException(400, "This project is inactive.")
    fy = _check_fy(body.financial_year)
    name = _clean(body.name, 200)
    if not name:
        raise HTTPException(400, "Enter the FOC name.")
    # The FOC goes to the project's in-charge.
    if not project.incharge_id:
        raise HTTPException(400, "This project has no FOC in-charge yet. Set one on the project first.")
    incharge = _assignable(await db.get(User, project.incharge_id), "FOC in-charge")
    lines = _checked_lines(body.lines)
    await _duplicate_check(db, project.id, fy, name)
    sheet = FocSheet(project_id=project.id, financial_year=fy, name=name, incharge_id=incharge.id,
                     status=FocStatus.DRAFT.value, created_by=admin.id)
    db.add(sheet)
    await db.flush()
    for i, (_, sub, sanctioned, available) in enumerate(lines, start=1):
        db.add(FocLine(sheet_id=sheet.id, sl_no=i, sub_head=sub, sanctioned_fund=sanctioned, available_fund=available,
                       amount_required=Decimal("0")))
    _notify(db, incharge.id, "New FOC assigned to you",
            f"FOC “{name}” ({project.name}, {fy}) is ready for you to fill in.")
    await db.commit()
    return await _sheet_out(db, await _load_sheet(db, sheet.id), admin)


@router.patch("/sheets/{sheet_id}")
async def update_sheet(sheet_id: UUID, body: SheetUpdate, db: AsyncSession = Depends(get_db), admin: User = Depends(_super)):
    sheet = await _load_sheet(db, sheet_id, lock=True)
    if sheet.status not in (FocStatus.DRAFT.value, FocStatus.REJECTED.value):
        raise HTTPException(409, "This FOC can only be changed while it is a draft or after it has been returned.")
    sent = body.model_fields_set
    fy = _check_fy(body.financial_year) if "financial_year" in sent and body.financial_year else sheet.financial_year
    name = _clean(body.name, 200) if "name" in sent else sheet.name
    if not name:
        raise HTTPException(400, "Enter the FOC name.")
    if (fy, name) != (sheet.financial_year, sheet.name):
        await _duplicate_check(db, sheet.project_id, fy, name, exclude=sheet.id)
    sheet.financial_year, sheet.name = fy, name
    if body.lines is not None:
        checked = _checked_lines(body.lines)
        existing = {ln.id: ln for ln in sheet.lines}
        keep = set()
        for i, (ln_in, sub, sanctioned, available) in enumerate(checked, start=1):
            line = existing.get(ln_in.id) if ln_in.id else None
            if ln_in.id and not line:
                raise HTTPException(400, f"Line {i} does not belong to this FOC.")
            if line is None:
                line = FocLine(sheet_id=sheet.id, amount_required=Decimal("0"))
                db.add(line)
            elif (line.amount_required or 0) > available:
                raise HTTPException(400, f"Line {i}: the in-charge has already asked for {_fmt(line.amount_required)}, "
                                         "which is more than the new available fund.")
            line.sl_no, line.sub_head, line.sanctioned_fund, line.available_fund = i, sub, sanctioned, available
            if line.id:
                keep.add(line.id)
        for lid, line in existing.items():
            if lid not in keep:
                _delete_doc_file(line)
                await db.delete(line)
    sheet.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return await _sheet_out(db, await _load_sheet(db, sheet.id), admin)


@router.delete("/sheets/{sheet_id}", status_code=204)
async def delete_sheet(sheet_id: UUID, db: AsyncSession = Depends(get_db), _: User = Depends(_super)):
    sheet = await _load_sheet(db, sheet_id)
    if sheet.movements:
        raise HTTPException(409, "This FOC has already been sent for approval, so it is part of the record and cannot be deleted.")
    for line in sheet.lines:
        _delete_doc_file(line)
    await db.delete(sheet)
    await db.commit()


# ── In-charge ────────────────────────────────────────────────────────────────

class EntryIn(BaseModel):
    line_id: UUID
    amount_required: Decimal | float | str | None = None
    sanction_order_no: Optional[str] = None
    purpose: Optional[str] = None
    remark: Optional[str] = None


class SubmitIn(BaseModel):
    ddo_user_id: UUID
    certified: bool = False
    remark: Optional[str] = None


class ActionIn(BaseModel):
    remark: Optional[str] = None


@router.get("/sheets/mine")
async def my_sheets(db: AsyncSession = Depends(get_db), user: User = Depends(_user)):
    rows = (await db.execute(
        select(FocSheet).options(
            selectinload(FocSheet.project).selectinload(FocProject.establishment),
            selectinload(FocSheet.project).selectinload(FocProject.department),
            selectinload(FocSheet.incharge), selectinload(FocSheet.holder), selectinload(FocSheet.lines),
        ).where(FocSheet.incharge_id == user.id).order_by(FocSheet.updated_at.desc())
    )).scalars().all()
    return [_summary(s) for s in rows]


@router.put("/sheets/{sheet_id}/entries")
async def save_entries(sheet_id: UUID, entries: list[EntryIn], db: AsyncSession = Depends(get_db), user: User = Depends(_user)):
    sheet = await _load_sheet(db, sheet_id, lock=True)
    if not _editable_by_incharge(sheet, user):
        raise HTTPException(403, "Only the in-charge can fill in this FOC, and only while it is a draft or after it has been returned.")
    lines = {ln.id: ln for ln in sheet.lines}
    for e in entries:
        line = lines.get(e.line_id)
        if not line:
            raise HTTPException(400, "A line in the request does not belong to this FOC.")
        sent = e.model_fields_set
        if "amount_required" in sent:
            amount = _money(e.amount_required, "Amount required", line.sl_no)
            if amount > (line.available_fund or 0):
                raise HTTPException(400, f"Line {line.sl_no} ({line.sub_head}): the amount required ({_fmt(amount)}) "
                                         f"is more than the available fund ({_fmt(line.available_fund)}).")
            line.amount_required = amount
        if "sanction_order_no" in sent:
            line.sanction_order_no = _clean(e.sanction_order_no, 200)
        if "purpose" in sent:
            line.purpose = _clean(e.purpose, 2000)
        if "remark" in sent:
            line.remark = _clean(e.remark, 2000)
    sheet.certified = False   # any change needs a fresh certificate
    sheet.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return await _sheet_out(db, await _load_sheet(db, sheet.id), user)


@router.post("/sheets/{sheet_id}/lines/{line_id}/document")
async def upload_document(sheet_id: UUID, line_id: UUID, upload: UploadFile = File(...),
                          db: AsyncSession = Depends(get_db), user: User = Depends(_user)):
    sheet = await _load_sheet(db, sheet_id, lock=True)
    if not _editable_by_incharge(sheet, user):
        raise HTTPException(403, "Only the in-charge can attach documents, and only while the FOC is a draft or has been returned.")
    line = next((ln for ln in sheet.lines if ln.id == line_id), None)
    if not line:
        raise HTTPException(404, "Line not found.")
    name = upload.filename or "document"
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext not in DOC_EXTENSIONS:
        raise HTTPException(400, f"Upload a PDF, image or Word file ({', '.join(sorted(DOC_EXTENSIONS))}).")
    content = await upload.read()
    if not content:
        raise HTTPException(400, "The file is empty.")
    if len(content) > settings.MAX_FILE_SIZE_MB * 1024 * 1024:
        raise HTTPException(400, f"The file is larger than {settings.MAX_FILE_SIZE_MB} MB.")
    stored = f"{_uuid.uuid4()}.{ext}"
    async with aiofiles.open(os.path.join(_doc_dir(), stored), "wb") as out:
        await out.write(content)
    _delete_doc_file(line)
    line.document_original_name = name[:255]
    line.document_stored_name = stored
    line.document_size = len(content)
    line.document_mime = upload.content_type
    sheet.certified = False
    await db.commit()
    return _line_out(line, sheet.id)


@router.delete("/sheets/{sheet_id}/lines/{line_id}/document", status_code=204)
async def delete_document(sheet_id: UUID, line_id: UUID, db: AsyncSession = Depends(get_db), user: User = Depends(_user)):
    sheet = await _load_sheet(db, sheet_id, lock=True)
    if not _editable_by_incharge(sheet, user):
        raise HTTPException(403, "Only the in-charge can remove documents, and only while the FOC is a draft or has been returned.")
    line = next((ln for ln in sheet.lines if ln.id == line_id), None)
    if not line or not line.document_stored_name:
        raise HTTPException(404, "No document on this line.")
    _delete_doc_file(line)
    line.document_original_name = line.document_stored_name = line.document_mime = None
    line.document_size = None
    sheet.certified = False
    await db.commit()


@router.get("/sheets/{sheet_id}/lines/{line_id}/document")
async def view_document(sheet_id: UUID, line_id: UUID, download: bool = False,
                        db: AsyncSession = Depends(get_db), user: User = Depends(_user)):
    sheet = await _load_sheet(db, sheet_id)
    if not await _can_view(db, sheet, user):
        raise HTTPException(403, "You do not have access to this FOC.")
    line = next((ln for ln in sheet.lines if ln.id == line_id), None)
    if not line or not line.document_stored_name:
        raise HTTPException(404, "No document on this line.")
    path = os.path.join(_doc_dir(), line.document_stored_name)
    if not os.path.isfile(path):
        raise HTTPException(404, "The document file is missing on the server.")
    return FileResponse(
        path, media_type=line.document_mime or "application/octet-stream",
        filename=line.document_original_name or "document",
        content_disposition_type="attachment" if download else "inline",
    )


@router.post("/sheets/{sheet_id}/submit")
async def submit_sheet(sheet_id: UUID, body: SubmitIn, db: AsyncSession = Depends(get_db), user: User = Depends(_user)):
    sheet = await _load_sheet(db, sheet_id, lock=True)
    if not _editable_by_incharge(sheet, user):
        raise HTTPException(403, "Only the in-charge can send this FOC, and only while it is a draft or after it has been returned.")
    if not body.certified:
        raise HTTPException(400, "Please tick the certificate that the data entered is checked and correct.")
    total = sum((ln.amount_required or Decimal("0")) for ln in sheet.lines)
    if total <= 0:
        raise HTTPException(400, "Enter the amount required on at least one line before sending.")
    for ln in sheet.lines:
        if (ln.amount_required or 0) > (ln.available_fund or 0):
            raise HTTPException(400, f"Line {ln.sl_no} ({ln.sub_head}): the amount required is more than the available fund.")
    if body.ddo_user_id == user.id:
        raise HTTPException(400, "You cannot send the FOC to yourself.")
    is_ddo = (await db.execute(select(FocOfficer.id).where(
        FocOfficer.role == FocOfficerRole.DDO.value, FocOfficer.user_id == body.ddo_user_id))).first()
    ddo = await db.get(User, body.ddo_user_id)
    if not is_ddo or not ddo or not ddo.is_active:
        raise HTTPException(400, "Choose one of the DDOs from the list.")
    remark = _clean(body.remark, 4000)
    now = datetime.now(timezone.utc)
    sheet.status, sheet.stage = FocStatus.PENDING.value, FocOfficerRole.DDO.value
    sheet.holder_id = sheet.ddo_id = ddo.id
    sheet.certified, sheet.submitted_at, sheet.updated_at = True, now, now
    db.add(FocMovement(sheet_id=sheet.id, action="submitted", from_user_id=user.id, to_user_id=ddo.id,
                       from_stage=None, to_stage=FocOfficerRole.DDO.value, remark=remark))
    _notify(db, ddo.id, "FOC received", f"FOC #{sheet.number} “{sheet.name}” from {user.full_name} is waiting in your FOC Docket.")
    await db.commit()
    return await _sheet_out(db, await _load_sheet(db, sheet.id), user)


# ── Officers ─────────────────────────────────────────────────────────────────

async def _holding(db: AsyncSession, sheet_id: UUID, user: User) -> FocSheet:
    sheet = await _load_sheet(db, sheet_id, lock=True)
    if not await _handles(db, sheet, user):
        raise HTTPException(409, "This FOC is not waiting with you (it may already have been acted on, "
                                 "or the role has passed to someone else).")
    # A fixed office handed over in eFMS: the new holder acts on it.
    sheet.holder_id = user.id
    return sheet


def _decide(db: AsyncSession, sheet: FocSheet, user: User, action: str, remark: Optional[str]) -> None:
    now = datetime.now(timezone.utc)
    stage = sheet.stage
    db.add(FocMovement(sheet_id=sheet.id, action=action, from_user_id=user.id, to_user_id=sheet.incharge_id,
                       from_stage=stage, to_stage=None, remark=remark))
    sheet.status = FocStatus.APPROVED.value if action == "approved" else FocStatus.REJECTED.value
    sheet.decided_by, sheet.decided_stage, sheet.decided_at = user.id, stage, now
    sheet.stage = sheet.holder_id = None
    if action == "rejected":
        sheet.certified = False
    sheet.updated_at = now


@router.post("/sheets/{sheet_id}/approve")
async def approve_sheet(sheet_id: UUID, body: ActionIn, db: AsyncSession = Depends(get_db), user: User = Depends(_user)):
    sheet = await _holding(db, sheet_id, user)
    stage_title = _stage_title(sheet.stage)
    _decide(db, sheet, user, "approved", _clean(body.remark, 4000))
    _notify(db, sheet.incharge_id, "FOC approved",
            f"FOC #{sheet.number} “{sheet.name}” was approved by {user.full_name} ({stage_title}). You can download it now.")
    await db.commit()
    return await _sheet_out(db, await _load_sheet(db, sheet.id), user)


@router.post("/sheets/{sheet_id}/reject")
async def reject_sheet(sheet_id: UUID, body: ActionIn, db: AsyncSession = Depends(get_db), user: User = Depends(_user)):
    remark = _clean(body.remark, 4000)
    if not remark:
        raise HTTPException(400, "Please write a remark explaining why the FOC is being returned.")
    sheet = await _holding(db, sheet_id, user)
    stage_title = _stage_title(sheet.stage)
    _decide(db, sheet, user, "rejected", remark)
    _notify(db, sheet.incharge_id, "FOC returned",
            f"FOC #{sheet.number} “{sheet.name}” was returned by {user.full_name} ({stage_title}): {remark[:200]}")
    await db.commit()
    return await _sheet_out(db, await _load_sheet(db, sheet.id), user)


@router.post("/sheets/{sheet_id}/forward")
async def forward_sheet(sheet_id: UUID, body: ActionIn, db: AsyncSession = Depends(get_db), user: User = Depends(_user)):
    sheet = await _holding(db, sheet_id, user)
    index = FOC_CHAIN.index(FocOfficerRole(sheet.stage))
    if index + 1 >= len(FOC_CHAIN):
        raise HTTPException(400, "The Vice Chancellor is the last stage — please approve or return the FOC.")
    next_role = FOC_CHAIN[index + 1]
    nxt = await _fixed(db, next_role)
    if nxt.problem:
        raise HTTPException(409, f"The FOC cannot be forwarded: {nxt.problem}")
    target = nxt.holder
    if target.id == user.id:
        raise HTTPException(400, f"You also hold the {ROLE_TITLES[next_role]} role — approve or return the FOC instead.")
    remark = _clean(body.remark, 4000)
    db.add(FocMovement(sheet_id=sheet.id, action="forwarded", from_user_id=user.id, to_user_id=target.id,
                       from_stage=sheet.stage, to_stage=next_role.value, remark=remark))
    sheet.stage, sheet.holder_id = next_role.value, target.id
    sheet.updated_at = datetime.now(timezone.utc)
    _notify(db, target.id, "FOC received",
            f"FOC #{sheet.number} “{sheet.name}” was forwarded to you by {user.full_name}.")
    await db.commit()
    return await _sheet_out(db, await _load_sheet(db, sheet.id), user)


# ── Docket / history / detail ────────────────────────────────────────────────

def _summary_options():
    return (
        selectinload(FocSheet.project).selectinload(FocProject.establishment),
        selectinload(FocSheet.project).selectinload(FocProject.department),
        selectinload(FocSheet.incharge), selectinload(FocSheet.holder), selectinload(FocSheet.lines),
        selectinload(FocSheet.movements).selectinload(FocMovement.from_user),
    )


@router.get("/docket")
async def foc_docket(db: AsyncSession = Depends(get_db), user: User = Depends(_user)):
    """Waiting with me (officer) + come back to me (in-charge: approved or
    returned). Newest first."""
    my_fixed = [r for r in await _officer_roles(db, user.id) if r != FocOfficerRole.DDO.value]
    rows = (await db.execute(
        select(FocSheet).options(*_summary_options()).where(or_(
            (FocSheet.status == FocStatus.PENDING.value) & (FocSheet.holder_id == user.id),
            (FocSheet.status == FocStatus.PENDING.value) & FocSheet.stage.in_(my_fixed or [""]),
            (FocSheet.incharge_id == user.id) & FocSheet.status.in_([FocStatus.APPROVED.value, FocStatus.REJECTED.value]),
        ))
    )).scalars().all()
    out = []
    for s in rows:
        if s.status == FocStatus.PENDING.value:
            if not await _handles(db, s, user):
                continue  # the office has passed to someone else
            last_in = s.movements[-1] if s.movements else None
            out.append(_summary(s, last_in.from_user if last_in else s.incharge,
                                last_in.created_at if last_in else s.submitted_at, box="to_process"))
        else:
            last = next((m for m in reversed(s.movements) if m.action in ("approved", "rejected")), None)
            out.append(_summary(s, last.from_user if last else None, last.created_at if last else s.decided_at,
                                box="approved" if s.status == FocStatus.APPROVED.value else "returned"))
    out.sort(key=lambda r: r["dispatched_at"] or "", reverse=True)
    return out


@router.get("/history")
async def foc_history(db: AsyncSession = Depends(get_db), user: User = Depends(_user)):
    """Every FOC I have acted on as an officer (or sent as in-charge)."""
    acted = select(FocMovement.sheet_id).where(FocMovement.from_user_id == user.id)
    rows = (await db.execute(
        select(FocSheet).options(*_summary_options()).where(FocSheet.id.in_(acted)).order_by(FocSheet.updated_at.desc())
    )).scalars().all()
    out = []
    for s in rows:
        mine = next((m for m in reversed(s.movements) if m.from_user_id == user.id), None)
        row = _summary(s, s.incharge, s.submitted_at)
        row["my_last_action"] = mine.action if mine else None
        row["my_last_action_at"] = mine.created_at.isoformat() if mine and mine.created_at else None
        out.append(row)
    return out


@router.get("/sheets/{sheet_id}")
async def get_sheet(sheet_id: UUID, db: AsyncSession = Depends(get_db), user: User = Depends(_user)):
    sheet = await _load_sheet(db, sheet_id)
    if not await _can_view(db, sheet, user):
        raise HTTPException(403, "You do not have access to this FOC.")
    return await _sheet_out(db, sheet, user)


# ── PDF ──────────────────────────────────────────────────────────────────────

_PDF_CSS = """
@page { size: A4; margin: 15px; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: Arial, "Helvetica Neue", Helvetica, "Liberation Sans", sans-serif; font-size: 12px; line-height: 1.5; color: #1A1A1A; }
.doc-title { text-align: center; font-size: 13px; font-weight: 700; letter-spacing: 4px; color: #0A5757; margin: 12px 0 2px 0; text-transform: uppercase; }
.sub-title { text-align: center; font-size: 12px; font-weight: 700; color: #1A1A1A; margin: 0 0 2px 0; }
.meta { text-align: center; font-size: 10px; color: #7C8A8A; margin-bottom: 10px; }
table.info, table.lines, table.trail { width: 100%; border-collapse: collapse; margin: 8px 0; }
table.info td { border: 1px solid #BFDEDB; padding: 5px 7px; vertical-align: top; }
table.info td.k { background: #EEF6F5; color: #0A5757; font-weight: 700; width: 19%; }
table.lines th, table.lines td, table.trail th, table.trail td { border: 1px solid #BFDEDB; padding: 5px 6px; vertical-align: top; }
table.lines th, table.trail th { background: #0D6E6E; color: #fff; font-size: 10.5px; text-transform: uppercase; letter-spacing: .3px; }
table.lines td.n { text-align: right; white-space: nowrap; }
table.lines tr.total td { font-weight: 700; background: #EEF6F5; }
.section { font-size: 11px; font-weight: 700; letter-spacing: 1px; color: #0A5757; text-transform: uppercase; margin: 14px 0 4px 0; }
.approved { margin-top: 12px; padding: 8px 10px; border: 1px solid #0D6E6E; background: #F4FAF9; font-weight: 700; color: #0A5757; }
.footer { margin-top: 18px; border-top: 1.5px solid #0D6E6E; padding-top: 4px; font-size: 9.5px; color: #7C8A8A; text-align: center; }
"""


def _ist(dt: Optional[datetime]) -> str:
    if not dt:
        return "—"
    return dt.astimezone(ZoneInfo("Asia/Kolkata")).strftime("%d %b %Y, %I:%M %p")


def _indian_number(d: Decimal) -> str:
    s = f"{d:.2f}"
    whole, frac = s.split(".")
    neg = whole.startswith("-")
    whole = whole.lstrip("-")
    if len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        whole = ",".join(groups + [tail])
    return f"{'-' if neg else ''}{whole}.{frac}"


def build_foc_html(sheet: FocSheet) -> str:
    p = sheet.project
    total = sum((ln.amount_required or Decimal("0")) for ln in sheet.lines)
    approve = next((m for m in reversed(sheet.movements) if m.action == "approved"), None)
    rows = "".join(
        f"<tr><td>{ln.sl_no}</td><td>{_esc(ln.sub_head)}</td><td>{_esc(ln.purpose or '')}</td>"
        f"<td class='n'>{_indian_number(ln.sanctioned_fund or Decimal(0))}</td>"
        f"<td class='n'>{_indian_number(ln.available_fund or Decimal(0))}</td>"
        f"<td class='n'>{_indian_number(ln.amount_required or Decimal(0))}</td>"
        f"<td>{_esc(ln.sanction_order_no or '')}</td><td>{_esc(ln.remark or '')}</td></tr>"
        for ln in sheet.lines
    )
    trail = "".join(
        f"<tr><td>{_ist(m.created_at)}</td><td>{_esc(m.action.capitalize())}</td>"
        f"<td>{_esc(_person_label(m.from_user))}<br><span style='color:#7C8A8A'>{_esc(_stage_title(m.from_stage) or 'In-charge')}</span></td>"
        f"<td>{_esc(_person_label(m.to_user)) if m.to_user else '—'}</td><td>{_esc(m.remark or '')}</td></tr>"
        for m in sheet.movements
    )

    def kv(k1, v1, k2, v2):
        return f"<tr><td class='k'>{k1}</td><td>{_esc(v1 or '—')}</td><td class='k'>{k2}</td><td>{_esc(v2 or '—')}</td></tr>"

    office = " / ".join(x for x in (p.establishment.name if p.establishment else None,
                                     p.department.name if p.department else None) if x) or "—"
    approved_html = (
        f"<div class='approved'>Approved by {_esc(_person_label(approve.from_user))} — "
        f"{_esc(_stage_title(approve.from_stage))}, on {_ist(approve.created_at)} IST"
        f"{(' — Remark: ' + _esc(approve.remark)) if approve and approve.remark else ''}</div>"
    ) if approve else ""
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>FOC {sheet.number}</title>
<style>{LETTERHEAD_CSS}{_PDF_CSS}</style></head><body>
{letterhead_html(letterhead_logo_html())}
<div class="doc-title">Fixation of Ceiling</div>
<div class="sub-title">{_esc(office)}</div>
<div class="meta">FOC No. {sheet.number} &middot; Generated {_ist(datetime.now(timezone.utc))} IST</div>
<table class="info">
{kv("Name of the Project", p.name, "Funded By", p.funded_by)}
{kv("Funding Agency", p.funding_agency, "F.O.C. Creation Date", _ist(sheet.created_at))}
{kv("FOC In-charge", _person_label(sheet.incharge), "Establishment / Office", office)}
{kv("Type of Project", p.project_type, "Financial Year", sheet.financial_year)}
{kv("F.O.C. Name", sheet.name, "Fund Sanction Remittance No.", p.fund_sanction_remittance_no)}
</table>
<div class="section">Fund requirement</div>
<table class="lines">
<tr><th>#</th><th>Sub Head</th><th>Purpose</th><th>Budget Allotment F.Y.: {_esc(sheet.financial_year)}</th>
<th>Balance Available</th><th>Amount Required for this Proposal</th><th>Sanction Order No.</th><th>Remarks</th></tr>
{rows}
<tr class="total"><td colspan="5">Total Amount Required: {_esc(rupees_in_words(total))}</td><td class="n">{_indian_number(total)}</td><td colspan="2"></td></tr>
</table>
<div class="section">Bank and fund information</div>
<table class="info">
{kv("Account Holder", p.bank_account_holder, "Bank", p.bank_name)}
{kv("Account No.", p.bank_account_no, "Fund Received Instrument No.", p.fund_instrument_no)}
{kv("Fund Received Date", p.fund_received_date.strftime('%d %b %Y') if p.fund_received_date else None, "Total Amount Required", "Rs. " + _indian_number(total))}
</table>
{approved_html}
<div class="section">Movement</div>
<table class="trail"><tr><th>Date (IST)</th><th>Action</th><th>By</th><th>To</th><th>Remark</th></tr>{trail}</table>
<div class="footer">Assam Veterinary and Fishery University &bull; eFMS — FOC (Fixation of Ceiling)</div>
</body></html>"""


@router.get("/sheets/{sheet_id}/pdf")
async def download_pdf(sheet_id: UUID, db: AsyncSession = Depends(get_db), user: User = Depends(_user)):
    sheet = await _load_sheet(db, sheet_id)
    if not await _can_view(db, sheet, user):
        raise HTTPException(403, "You do not have access to this FOC.")
    if sheet.status != FocStatus.APPROVED.value:
        raise HTTPException(409, "The FOC can be downloaded once it has been approved.")
    html = build_foc_html(sheet)

    from starlette.concurrency import run_in_threadpool
    from app.utils.html_pdf import render_html_to_pdf, ChromiumUnavailable, ChromiumRenderFailed
    from app.utils.doc_convert import convert_html_to_pdf, DocConversionUnavailable, DocConversionFailed
    from app.utils import html_pdf as _html_pdf_mod

    pdf_bytes = None
    try:
        pdf_bytes = await run_in_threadpool(_html_pdf_mod.render_html_to_pdf, html)
    except ChromiumUnavailable:
        pdf_bytes = None
    except ChromiumRenderFailed:
        raise HTTPException(422, "Failed to generate the FOC PDF.")
    if pdf_bytes is None:
        try:
            pdf_bytes = convert_html_to_pdf(html.encode("utf-8"))
        except DocConversionUnavailable:
            raise HTTPException(503, "PDF generation is not available on this server.")
        except DocConversionFailed:
            raise HTTPException(422, "Failed to generate the FOC PDF.")
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", f"FOC-{sheet.number}-{sheet.name}").strip("-")
    return Response(content=pdf_bytes, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{safe}.pdf"'})
