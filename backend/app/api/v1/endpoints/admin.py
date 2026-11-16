"""Super-admin endpoints: manage categories, priorities, recipients, notifications, users."""
from datetime import datetime
import csv
import io
import re
from typing import Optional, List

import openpyxl
import openpyxl.styles
from uuid import UUID
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from app.utils.workspace import role_context as role_context_of
from sqlalchemy.orm import selectinload
from pydantic import BaseModel

from app.db.base import get_db
from app.utils.integrity import blocked, department_blockers, establishment_blockers
from app.core.dependencies import require_roles, get_current_user
from app.models.user import User, UserRole, SystemRole, FavoriteRecipient, FormerRoleHolding, DeactivationReasonType
from app.utils.retirement import retired_role_names
from app.models.admin import FileCategory, FilePriority, FileRecipient, Notification
from app.models.organization import Establishment, Department
from app.models.efms import EfmsFile
from app.models.efms_extra import Docket

router = APIRouter(prefix="/admin", tags=["Super Admin"])
_super = require_roles(SystemRole.SUPER_ADMIN)
_any_role = get_current_user


# ── Schemas ───────────────────────────────────────────────────────────────────

class CategoryIn(BaseModel):
    name: str
    description: Optional[str] = None

class CategoryOut(BaseModel):
    id: UUID; name: str; description: Optional[str]; is_active: bool
    model_config = {"from_attributes": True}

class PriorityIn(BaseModel):
    name: str; label: str

class PriorityOut(BaseModel):
    id: UUID; name: str; label: str; is_active: bool
    model_config = {"from_attributes": True}

class RecipientIn(BaseModel):
    name: str
    designation: Optional[str] = None
    email: Optional[str] = None
    user_id: Optional[UUID] = None

class RecipientOut(BaseModel):
    id: UUID; name: str; designation: Optional[str]
    email: Optional[str]; user_id: Optional[UUID]; is_active: bool
    model_config = {"from_attributes": True}

class UserOut(BaseModel):
    id: UUID; email: str; full_name: str; active_role: Optional[str]; designation: Optional[str]
    department_name: Optional[str] = None
    employee_code: Optional[str] = None
    is_favorite: bool = False
    favorite_created_at: Optional[datetime] = None
    # Set only for a project profile (see User.origin_user_id/project_id) —
    # lets the recipient picker show a clear "Project" badge next to
    # "User A PI74" so it never reads as merely another label for "User A".
    is_project_profile: bool = False
    project_number: Optional[str] = None
    project_name: Optional[str] = None
    # A person deactivated with the reason "Retired" can still be sent files
    # (their Docket). They are listed once, with the roles they held and the
    # retirement date, which is how several retired people of one role are
    # told apart. `role` stays empty for them.
    is_retired: bool = False
    retired_at: Optional[datetime] = None
    retired_roles: List[str] = []
    # The specific role this recipient entry represents. For a single-role
    # user it equals active_role. For a multi-role user the picker returns
    # one entry PER role, each with its own `role` — the sender forwards to
    # "<person> — <role>", and the file lands in that role's Docket only.
    role: Optional[str] = None
    # Set only when this person holds `role` in more than one establishment /
    # department: the exact user_roles row this entry targets, and a label
    # ("<establishment> · <department>") telling the entries apart. Forward
    # sends user_role_id back so the file lands in that context's Docket.
    user_role_id: Optional[UUID] = None
    role_context: Optional[str] = None
    model_config = {"from_attributes": True}

    @classmethod
    def from_user(cls, u: User, role: Optional[str] = None,
                  user_role_id: Optional[UUID] = None, role_context: Optional[str] = None):
        return cls(id=u.id, email=u.email, full_name=u.full_name,
                   active_role=u.active_role,
                   role=role if role is not None else u.active_role,
                   user_role_id=user_role_id, role_context=role_context,
                   designation=getattr(u, "designation", None),
                   department_name=u.department.name if u.department else None,
                   employee_code=getattr(u, "employee_code", None),
                   is_project_profile=u.is_project_profile,
                   project_number=u.project.project_number if u.project else None,
                   project_name=u.project.name if u.project else None)

class NotificationOut(BaseModel):
    id: UUID; title: str; message: Optional[str]; type: str
    file_id: Optional[UUID]; is_read: bool
    model_config = {"from_attributes": True}


# ── Categories ────────────────────────────────────────────────────────────────

@router.get("/categories", response_model=List[CategoryOut])
async def list_categories(db: AsyncSession = Depends(get_db)):
    r = await db.execute(select(FileCategory).order_by(FileCategory.name))
    return r.scalars().all()


@router.post("/categories", response_model=CategoryOut, status_code=201)
async def create_category(body: CategoryIn, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    c = FileCategory(**body.model_dump())
    db.add(c); await db.commit(); await db.refresh(c)
    return c


@router.patch("/categories/{cid}", response_model=CategoryOut)
async def update_category(cid: UUID, body: CategoryIn, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    c = await db.get(FileCategory, cid)
    if not c: raise HTTPException(404, "Category not found")
    for k, v in body.model_dump(exclude_none=True).items(): setattr(c, k, v)
    await db.commit(); await db.refresh(c)
    return c


@router.patch("/categories/{cid}/toggle", response_model=CategoryOut)
async def toggle_category(cid: UUID, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    c = await db.get(FileCategory, cid)
    if not c: raise HTTPException(404, "Category not found")
    c.is_active = not c.is_active
    await db.commit(); await db.refresh(c)
    return c


@router.delete("/categories/{cid}", status_code=204)
async def delete_category(cid: UUID, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    c = await db.get(FileCategory, cid)
    if not c: raise HTTPException(404, "Category not found")
    try:
        await db.delete(c); await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(400, "Category is in use and cannot be deleted. Toggle to hide it instead.")


# ── Priorities ────────────────────────────────────────────────────────────────

@router.get("/priorities", response_model=List[PriorityOut])
async def list_priorities(db: AsyncSession = Depends(get_db)):
    r = await db.execute(select(FilePriority).order_by(FilePriority.label))
    return r.scalars().all()


@router.post("/priorities", response_model=PriorityOut, status_code=201)
async def create_priority(body: PriorityIn, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    p = FilePriority(**body.model_dump())
    db.add(p); await db.commit(); await db.refresh(p)
    return p


@router.patch("/priorities/{pid}/toggle", response_model=PriorityOut)
async def toggle_priority(pid: UUID, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    p = await db.get(FilePriority, pid)
    if not p: raise HTTPException(404, "Priority not found")
    p.is_active = not p.is_active
    await db.commit(); await db.refresh(p)
    return p


@router.delete("/priorities/{pid}", status_code=204)
async def delete_priority(pid: UUID, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    p = await db.get(FilePriority, pid)
    if not p: raise HTTPException(404, "Priority not found")
    try:
        await db.delete(p); await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(400, "Priority is in use and cannot be deleted. Toggle to hide it instead.")


# ── Recipients ────────────────────────────────────────────────────────────────

@router.get("/recipients", response_model=List[RecipientOut])
async def list_recipients(db: AsyncSession = Depends(get_db)):
    r = await db.execute(select(FileRecipient).where(FileRecipient.is_active == True).order_by(FileRecipient.name))
    return r.scalars().all()


@router.get("/recipients/all", response_model=List[RecipientOut])
async def list_all_recipients(db: AsyncSession = Depends(get_db), _=Depends(_super)):
    r = await db.execute(select(FileRecipient).order_by(FileRecipient.name))
    return r.scalars().all()


@router.post("/recipients", response_model=RecipientOut, status_code=201)
async def create_recipient(body: RecipientIn, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    rec = FileRecipient(**body.model_dump())
    db.add(rec); await db.commit(); await db.refresh(rec)
    return rec


@router.patch("/recipients/{rid}", response_model=RecipientOut)
async def update_recipient(rid: UUID, body: RecipientIn, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    rec = await db.get(FileRecipient, rid)
    if not rec: raise HTTPException(404, "Recipient not found")
    for k, v in body.model_dump(exclude_none=True).items(): setattr(rec, k, v)
    await db.commit(); await db.refresh(rec)
    return rec


@router.patch("/recipients/{rid}/toggle", response_model=RecipientOut)
async def toggle_recipient(rid: UUID, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    rec = await db.get(FileRecipient, rid)
    if not rec: raise HTTPException(404, "Recipient not found")
    rec.is_active = not rec.is_active
    await db.commit(); await db.refresh(rec)
    return rec


@router.delete("/recipients/{rid}", status_code=204)
async def delete_recipient(rid: UUID, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    rec = await db.get(FileRecipient, rid)
    if not rec: raise HTTPException(404, "Recipient not found")
    try:
        await db.delete(rec); await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=400,
            detail="This recipient is linked to existing files and cannot be deleted. Use the toggle to hide it instead."
        )


# ── Users list (recipient/forward/signature pickers) ─────────────────────────
# Shared by every user-picker in the app (New File recipient, Forward dialog,
# Signature Permission grant). All non-SUPER_ADMIN roles are equal, ordinary
# eFMS roles (including any role Super Admin creates through Role
# Management) — eligibility is "active user with a role assigned", never a
# specific role name. A user with no role at all (active_role IS NULL) is
# excluded since they have no operational eFMS context to route a file to.

@router.get("/users", response_model=List[UserOut])
async def list_users(
    establishment_id: Optional[UUID] = Query(None, description="Office filter — optional"),
    department_id: Optional[UUID] = Query(None, description="Section filter — optional"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(_any_role),
):
    q = select(User).where(
        User.is_active == True,
        User.id != current_user.id,
        User.active_role.is_not(None),
        # Super Admin must never be selectable as a file recipient/forward
        # target — this endpoint is exclusively the recipient/forward/
        # signature-permission picker (see module comment above), so this
        # exclusion is safe to apply unconditionally here without affecting
        # User Management, which lists users via a separate endpoint
        # (GET /auth/admin/users) and still shows Super Admin accounts.
        User.active_role != SystemRole.SUPER_ADMIN,
    )
    if establishment_id:
        q = q.where(User.establishment_id == establishment_id)
    if department_id:
        q = q.where(User.department_id == department_id)
    r = await db.execute(
        q.options(
            selectinload(User.department), selectinload(User.project),
            selectinload(User.roles).selectinload(UserRole.department),
            selectinload(User.roles).selectinload(UserRole.establishment),
        )
        .order_by(User.first_name)
    )
    users = r.scalars().all()

    # One batched query for the caller's favorites — same "batch everything,
    # never N+1" style already used by person_info_map() elsewhere in eFMS.
    fav_result = await db.execute(
        select(FavoriteRecipient).where(FavoriteRecipient.user_id == current_user.id)
    )
    favorites = {f.recipient_id: f.created_at for f in fav_result.scalars().all()}

    out = []
    for u in users:
        # One entry per role the user holds (multi-role). A project profile
        # or a single-role user yields exactly one entry, unchanged from
        # before. SUPER_ADMIN role is filtered out at the query level.
        # A role held in several establishments/departments yields one entry
        # per context, each naming its context and user_roles row.
        held = [ur for ur in u.roles if ur.role != SystemRole.SUPER_ADMIN]
        counts: dict[str, int] = {}
        for ur in held:
            counts[ur.role] = counts.get(ur.role, 0) + 1
        entries: list[tuple] = []
        # Posts of the same role in the same place (people allowed to hold it
        # more than once) are told apart by their designation in the list.
        place_counts: dict[tuple, int] = {}
        for ur in held:
            k = (ur.role, *role_context_of(u, ur))
            place_counts[k] = place_counts.get(k, 0) + 1
        for ur in held:
            same_place = place_counts[(ur.role, *role_context_of(u, ur))] > 1
            shown_designation = ur.designation or (u.designation if same_place else None)
            if counts[ur.role] > 1:
                ctx = " · ".join(n for n in (
                    ur.establishment.name if ur.establishment else None,
                    ur.department.name if ur.department else None,
                    shown_designation,
                ) if n) or None
                entries.append((ur.role, ur.id, ctx, shown_designation))
            else:
                entries.append((ur.role, None, shown_designation, ur.designation))
        if not entries:
            entries = [(u.active_role if u.active_role else None, None, None, None)]
        for role, ur_id, ctx, role_designation in entries:
            item = UserOut.from_user(u, role=role, user_role_id=ur_id, role_context=ctx)
            # Each role entry shows that role's designation when it has one.
            if role_designation:
                item.designation = role_designation
            if u.id in favorites:
                item.is_favorite = True
                item.favorite_created_at = favorites[u.id]
            out.append(item)

    # Retired people: files can still be forwarded to them.
    retired = (await db.execute(
        select(User)
        .options(selectinload(User.department), selectinload(User.project), selectinload(User.roles))
        .where(
            User.is_active == False,
            User.origin_user_id.is_(None),
            User.deactivation_reason_type == DeactivationReasonType.RETIRED,
            User.id != current_user.id,
        )
        .order_by(User.first_name)
    )).scalars().all()
    if retired:
        if establishment_id:
            retired = [u for u in retired if u.establishment_id == establishment_id]
        if department_id:
            retired = [u for u in retired if u.department_id == department_id]
        holdings: dict = {}
        for h in (await db.execute(
            select(FormerRoleHolding).where(FormerRoleHolding.user_id.in_([u.id for u in retired]))
        )).scalars().all():
            holdings.setdefault(h.user_id, []).append(h)
        for u in retired:
            item = UserOut.from_user(u, role=None)
            item.role = None
            item.is_retired = True
            item.retired_at = u.deactivated_at
            item.retired_roles = retired_role_names(u, holdings.get(u.id, []))
            if u.id in favorites:
                item.is_favorite = True
                item.favorite_created_at = favorites[u.id]
            out.append(item)
    return out


# ── Favorite recipients (per-user, no admin privilege required) ──────────────
# A favorite is a relationship between the caller and another user, not an
# attribute of GET /admin/users itself — hence its own tiny resource rather
# than another query param on the list endpoint.

@router.post("/favorites/{recipient_id}", status_code=201)
async def add_favorite(
    recipient_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(_any_role),
):
    existing = await db.execute(
        select(FavoriteRecipient).where(
            FavoriteRecipient.user_id == current_user.id,
            FavoriteRecipient.recipient_id == recipient_id,
        )
    )
    if existing.scalar_one_or_none():
        return {"message": "Already a favorite."}
    db.add(FavoriteRecipient(user_id=current_user.id, recipient_id=recipient_id))
    try:
        await db.commit()
    except IntegrityError:
        # Concurrent duplicate add — the row already exists, which is the
        # desired end state, so this is not an error from the caller's view.
        await db.rollback()
    return {"message": "Added to favorites."}


@router.delete("/favorites/{recipient_id}", status_code=204)
async def remove_favorite(
    recipient_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(_any_role),
):
    result = await db.execute(
        select(FavoriteRecipient).where(
            FavoriteRecipient.user_id == current_user.id,
            FavoriteRecipient.recipient_id == recipient_id,
        )
    )
    fav = result.scalar_one_or_none()
    if fav:
        await db.delete(fav)
        await db.commit()
    # Deleting a favorite that doesn't exist is already the desired end
    # state — no error, matching the idempotent-delete convention used
    # elsewhere in this router (e.g. mark_read on a missing notification).


# ── Notifications ─────────────────────────────────────────────────────────────

@router.get("/notifications", response_model=List[NotificationOut])
async def my_notifications(db: AsyncSession = Depends(get_db), current_user: User = Depends(_any_role)):
    r = await db.execute(
        select(Notification)
        .where(Notification.user_id == current_user.id)
        .order_by(Notification.created_at.desc())
        .limit(50)
    )
    return r.scalars().all()


@router.patch("/notifications/{nid}/read", status_code=204)
async def mark_read(nid: UUID, db: AsyncSession = Depends(get_db), current_user: User = Depends(_any_role)):
    n = await db.get(Notification, nid)
    if n and n.user_id == current_user.id:
        n.is_read = True; await db.commit()


@router.patch("/notifications/read-all", status_code=204)
async def mark_all_read(db: AsyncSession = Depends(get_db), current_user: User = Depends(_any_role)):
    notifs = await db.execute(
        select(Notification).where(Notification.user_id == current_user.id, Notification.is_read == False)
    )
    for n in notifs.scalars(): n.is_read = True
    await db.commit()


# ── Notification helper (in-app only, no email) ───────────────────────────────

async def create_notification(db: AsyncSession, user_id: UUID, title: str, message: str,
                               file_id: Optional[UUID] = None, email_to: Optional[str] = None):
    n = Notification(user_id=user_id, title=title, message=message, file_id=file_id)
    db.add(n)


# ── Establishments ────────────────────────────────────────────────────────────

class EstablishmentIn(BaseModel):
    name: str; code: Optional[str] = None

class EstablishmentOut(BaseModel):
    id: UUID; name: str; code: Optional[str]; is_active: bool
    model_config = {"from_attributes": True}

class DeptIn(BaseModel):
    name: str; code: Optional[str] = None; establishment_id: Optional[UUID] = None

class DeptOut(BaseModel):
    id: UUID; name: str; code: Optional[str]; establishment_id: Optional[UUID]; is_active: bool
    model_config = {"from_attributes": True}


async def _department_code_conflict(db: AsyncSession, code: str, name: str, exclude: Optional[UUID] = None) -> Optional[Department]:
    """A DIFFERENT department that already uses this code. The same department
    (same name) may carry the same code in several establishments, but a code
    belongs to one department name. Compared ignoring case."""
    q = select(Department).where(
        func.lower(func.trim(Department.code)) == code.strip().lower(),
        func.lower(func.trim(Department.name)) != name.strip().lower(),
    )
    if exclude:
        q = q.where(Department.id != exclude)
    return (await db.execute(q)).scalars().first()


def _code_conflict_message(code: str, other: Department) -> str:
    return (f"The code “{code}” already belongs to the department “{other.name}”. "
            "The same code can only be used for a department of the same name.")


async def _department_exists(db: AsyncSession, establishment_id: Optional[UUID], name: str, exclude: Optional[UUID] = None) -> Optional[Department]:
    """The department of this name already in this establishment (names are
    compared ignoring case and surrounding spaces), or None."""
    q = select(Department).where(func.lower(func.trim(Department.name)) == name.strip().lower())
    q = q.where(Department.establishment_id == establishment_id) if establishment_id else q.where(Department.establishment_id.is_(None))
    if exclude:
        q = q.where(Department.id != exclude)
    return (await db.execute(q)).scalars().first()


@router.get("/establishments", response_model=List[EstablishmentOut])
async def list_establishments(db: AsyncSession = Depends(get_db)):
    r = await db.execute(select(Establishment).where(Establishment.is_active == True).order_by(Establishment.name))
    return r.scalars().all()

@router.get("/establishments/all", response_model=List[EstablishmentOut])
async def list_all_establishments(db: AsyncSession = Depends(get_db), _=Depends(_super)):
    r = await db.execute(select(Establishment).order_by(Establishment.name))
    return r.scalars().all()

@router.post("/establishments", response_model=EstablishmentOut, status_code=201)
async def create_establishment(body: EstablishmentIn, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    # The database column is NOT NULL — without this a blank code was a 500.
    if not (body.name or "").strip():
        raise HTTPException(400, "Enter a name for the establishment.")
    if not (body.code or "").strip():
        raise HTTPException(400, "Enter a code for the establishment (for example MAIN).")
    e = Establishment(**{**body.model_dump(), "name": body.name.strip(), "code": body.code.strip()})
    db.add(e); await db.commit(); await db.refresh(e)
    return e

@router.patch("/establishments/{eid}/toggle", response_model=EstablishmentOut)
async def toggle_establishment(eid: UUID, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    e = await db.get(Establishment, eid)
    if not e: raise HTTPException(404, "Not found")
    e.is_active = not e.is_active
    await db.commit(); await db.refresh(e)
    return e

def _fk_violation_table(exc: IntegrityError) -> Optional[str]:
    """Best-effort extraction of the referencing table name from a Postgres
    FK-violation error, so the fallback IntegrityError handler in
    delete_department/delete_establishment can name the real blocker even
    when it's a table this codebase doesn't own (e.g. `courses` — this
    Postgres database is shared with a sibling application, so a table with
    no SQLAlchemy model here can still hold a `department_id`/
    `establishment_id` FK and block a delete the explicit checks can't see).
    asyncpg's driver puts Postgres's own DETAIL text on the wrapped
    exception's __cause__; falls back to None if the shape ever changes."""
    detail = str(getattr(exc, "orig", None) or exc)
    # Postgres DETAIL looks like: 'Key (id)=(...) is still referenced from table "courses".'
    marker = 'is still referenced from table "'
    if marker in detail:
        return detail.split(marker, 1)[1].split('"', 1)[0]
    return None


@router.delete("/establishments/{eid}", status_code=204)
async def delete_establishment(eid: UUID, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    e = await db.get(Establishment, eid)
    if not e: raise HTTPException(404, "Not found")
    reasons = await establishment_blockers(db, eid)
    if reasons:
        raise blocked(
            f"Cannot delete the establishment “{e.name}”:",
            reasons,
            "You can hide it instead (the eye icon) — that keeps everything intact.",
        )
    try:
        await db.delete(e); await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        table = _fk_violation_table(exc)
        detail = f'Cannot delete — still referenced by the "{table}" table (outside eFMS). Toggle to hide instead.' if table \
            else "Establishment is still referenced elsewhere. Toggle to hide instead."
        raise HTTPException(400, detail)


@router.get("/departments", response_model=List[DeptOut])
async def list_departments(establishment_id: Optional[UUID] = None, db: AsyncSession = Depends(get_db)):
    q = select(Department).where(Department.is_active == True)
    if establishment_id:
        q = q.where(Department.establishment_id == establishment_id)
    r = await db.execute(q.order_by(Department.name))
    return r.scalars().all()

@router.get("/departments/all", response_model=List[DeptOut])
async def list_all_departments(db: AsyncSession = Depends(get_db), _=Depends(_super)):
    r = await db.execute(select(Department).order_by(Department.name))
    return r.scalars().all()

@router.post("/departments", response_model=DeptOut, status_code=201)
async def create_department(body: DeptIn, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    # The database column is NOT NULL — without this a blank code was a 500.
    if not (body.name or "").strip():
        raise HTTPException(400, "Enter a name for the department.")
    if not (body.code or "").strip():
        raise HTTPException(400, "Enter a code for the department (up to 4 letters, for example AGRO).")
    # The same department may exist in several establishments, but only
    # once in each.
    dup = await _department_exists(db, body.establishment_id, body.name)
    if dup:
        est = await db.get(Establishment, body.establishment_id) if body.establishment_id else None
        where = f" in “{est.name}”" if est else ""
        raise HTTPException(409, f"“{dup.name}” already exists{where}." + ("" if dup.is_active else " It is hidden — use the eye icon to show it again."))
    taken = await _department_code_conflict(db, body.code, body.name)
    if taken:
        raise HTTPException(409, _code_conflict_message(body.code.strip(), taken))
    d = Department(**{**body.model_dump(), "name": body.name.strip(), "code": body.code.strip()})
    db.add(d); await db.commit(); await db.refresh(d)
    return d


# ── Departments: pick existing ones ───────────────────────────────────────────

class DeptPick(BaseModel):
    name: str
    code: Optional[str] = None      # blank = the department's usual code


class DeptAddExistingIn(BaseModel):
    establishment_id: UUID
    items: List[DeptPick]


@router.get("/departments/names")
async def department_names(db: AsyncSession = Depends(get_db), _=Depends(_super)):
    """Every distinct department name across all establishments with the
    code(s) it carries and the establishments that have it — for adding a
    department other establishments already have."""
    rows = (await db.execute(select(Department).order_by(Department.name))).scalars().all()
    by_name: dict[str, dict] = {}
    for d in rows:
        entry = by_name.setdefault(d.name.strip().lower(), {"name": d.name.strip(), "codes": [], "establishment_ids": []})
        if d.code and d.code not in entry["codes"]:
            entry["codes"].append(d.code)
        if d.establishment_id:
            entry["establishment_ids"].append(str(d.establishment_id))
    out = []
    for e in by_name.values():
        e["code"] = e["codes"][0] if e["codes"] else None      # the usual one
        e["count"] = len(e["establishment_ids"])
        out.append(e)
    return sorted(out, key=lambda e: e["name"].lower())


@router.post("/departments/add-existing")
async def add_existing_departments(body: DeptAddExistingIn, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    """Add departments that other establishments already have to one
    establishment. The code is the department's usual one unless a different
    code is given for it. A department the establishment already has is
    skipped, never added twice."""
    est = await db.get(Establishment, body.establishment_id)
    if not est:
        raise HTTPException(404, "Establishment not found.")
    if not body.items:
        raise HTTPException(400, "Choose at least one department.")
    results = []
    seen: set[str] = set()
    for item in body.items:
        name = (item.name or "").strip()
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        res = {"name": name, "status": "failed", "code": None, "note": None}
        results.append(res)
        if await _department_exists(db, est.id, name):
            res["status"], res["note"] = "skipped", f"{est.name} already has “{name}”."
            continue
        code = (item.code or "").strip()
        if not code:
            existing = (await db.execute(select(Department).where(func.lower(func.trim(Department.name)) == name.lower(), Department.code.is_not(None)))).scalars().first()
            if not existing:
                res["note"] = f"No other establishment has “{name}” — create it instead."
                continue
            code = existing.code
        if len(code) > 50:
            res["note"] = "A code can have at most 50 characters."
            continue
        clash = await _department_code_conflict(db, code, name)
        if clash:
            res["note"] = _code_conflict_message(code, clash)
            continue
        db.add(Department(name=name, code=code, establishment_id=est.id, is_active=True))
        res["status"], res["code"] = "created", code
    await db.commit()
    return {
        "establishment": est.name, "results": results,
        "created": sum(1 for r in results if r["status"] == "created"),
        "skipped": sum(1 for r in results if r["status"] == "skipped"),
        "failed": sum(1 for r in results if r["status"] == "failed"),
    }


# ── Departments: bulk upload from Excel ───────────────────────────────────────
# Establishments and departments (each with its own code) can be added in one go
# by uploading a sheet with establishment name + code and department name + code.

_DEPT_SHEET_COLUMNS = ["Establishment Name", "Establishment Code", "Department Name", "Department Code"]
_DEPT_SHEET_KEYS = {"establishmentname": "est_name", "establishmentcode": "est_code",
                    "departmentname": "dept_name", "departmentcode": "dept_code"}
_DEPT_SHEET_MAX_ROWS = 2000
_DEPT_SHEET_MAX_BYTES = 2 * 1024 * 1024


class DeptBulkRowResult(BaseModel):
    row: int
    establishment: Optional[str] = None
    department: Optional[str] = None
    status: str          # "created" | "skipped" | "failed"
    note: Optional[str] = None


class DeptBulkResult(BaseModel):
    total: int
    created: int
    skipped: int
    failed: int
    establishments_created: int
    results: List[DeptBulkRowResult]


def _cell_text(v) -> str:
    """A cell as plain text. Excel stores 101 as 101.0 — a code typed as a
    number must not turn into "101.0"."""
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).strip()


def _read_dept_sheet(filename: str, raw: bytes) -> list[tuple[int, dict]]:
    """(sheet row number, {est_name, est_code, dept_name, dept_code}) for every
    non-empty row. Raises HTTPException(400) for an unusable file."""
    name = (filename or "").lower()
    if name.endswith(".xlsx"):
        try:
            wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        except Exception:
            raise HTTPException(400, "Could not read this Excel file. Please upload a .xlsx file saved from Excel.")
        rows_iter = wb.worksheets[0].iter_rows(values_only=True)
        table = [list(r) for r in rows_iter]
        wb.close()
    elif name.endswith(".csv"):
        try:
            text_ = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise HTTPException(400, "Could not read the file — please upload a UTF-8 CSV or an .xlsx file.")
        table = [list(r) for r in csv.reader(io.StringIO(text_))]
    else:
        raise HTTPException(400, "Please upload an Excel file (.xlsx). Use “Download template” to get the right columns.")
    if not table:
        raise HTTPException(400, "The file is empty.")
    header = [re.sub(r"[^a-z]", "", _cell_text(c).lower()) for c in table[0]]
    index = {_DEPT_SHEET_KEYS[h]: i for i, h in enumerate(header) if h in _DEPT_SHEET_KEYS}
    missing = [c for c in _DEPT_SHEET_COLUMNS if _DEPT_SHEET_KEYS[re.sub(r"[^a-z]", "", c.lower())] not in index]
    if missing:
        raise HTTPException(400, f"The first row must have these column headings: {', '.join(_DEPT_SHEET_COLUMNS)}. Missing: {', '.join(missing)}.")
    out = []
    for n, r in enumerate(table[1:], start=2):
        row = {k: _cell_text(r[i]) if i < len(r) else "" for k, i in index.items()}
        if any(row.values()):
            out.append((n, row))
    if len(out) > _DEPT_SHEET_MAX_ROWS:
        raise HTTPException(400, f"Too many rows ({len(out)}). Upload at most {_DEPT_SHEET_MAX_ROWS} at a time.")
    if not out:
        raise HTTPException(400, "The sheet has no data rows under the headings.")
    return out


@router.get("/departments/bulk/template")
async def download_department_template(_=Depends(_super)):
    """A ready-to-fill Excel sheet with the four columns and a few examples."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Departments"
    ws.append(_DEPT_SHEET_COLUMNS)
    for r in [
        ["College of Veterinary Science", "CVSC", "Department of Animal Nutrition", "CVNU"],
        ["College of Veterinary Science", "CVSC", "Accounts Section", "CVAC"],
        ["College of Fisheries", "COFR", "Department of Aquaculture", "COAQ"],
        ["College of Fisheries", "COFR", "Accounts Section", "COAC"],
    ]:
        ws.append(r)
    for c, w in zip("ABCD", (38, 20, 38, 20)):
        ws.column_dimensions[c].width = w
    for cell in ws[1]:
        cell.font = openpyxl.styles.Font(bold=True)
    for row in ws.iter_rows(min_row=1):
        for cell in row:
            cell.number_format = "@"     # codes stay text (no 101 → 101.0)
    help_ = wb.create_sheet("How to fill")
    for line in [
        "One row per department. Delete the example rows before you upload.",
        "Establishment Name + Establishment Code: if the establishment does not exist it is created.",
        "Department Name + Department Code: the code is whatever you give it. The same department in two establishments may have the same code or different ones.",
        "A department that the establishment already has (same name) is skipped, never duplicated.",
        "A code that already belongs to a department of a DIFFERENT name is refused for that row; other rows still go through.",
        "Codes are not case-sensitive (cvac and CVAC are the same).",
    ]:
        help_.append([line])
    help_.column_dimensions["A"].width = 120
    buf = io.BytesIO()
    wb.save(buf)
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="department_upload_template.xlsx"'},
    )


@router.post("/departments/bulk", response_model=DeptBulkResult)
async def bulk_upload_departments(file: UploadFile = File(...), db: AsyncSession = Depends(get_db), _=Depends(_super)):
    """Create establishments and departments from a sheet. Rows are checked
    and saved one at a time: a bad row is reported and skipped, it never
    undoes the rows that already went in."""
    raw = await file.read(_DEPT_SHEET_MAX_BYTES + 1)
    if len(raw) > _DEPT_SHEET_MAX_BYTES:
        raise HTTPException(400, "The file is larger than 2 MB.")
    rows = _read_dept_sheet(file.filename or "", raw)

    results: List[DeptBulkRowResult] = []
    est_created = 0
    for n, r in rows:
        est_name, est_code, dept_name, dept_code = r["est_name"], r["est_code"], r["dept_name"], r["dept_code"]
        res = DeptBulkRowResult(row=n, establishment=est_name or None, department=dept_name or None, status="failed")
        results.append(res)
        missing = [lbl for lbl, v in (("Establishment Name", est_name), ("Department Name", dept_name), ("Department Code", dept_code)) if not v]
        if missing:
            res.note = f"Missing: {', '.join(missing)}."
            continue
        if len(est_name) > 255 or len(dept_name) > 255 or len(est_code) > 50 or len(dept_code) > 50:
            res.note = "A value is too long (names up to 255 characters, codes up to 50)."
            continue
        try:
            est = (await db.execute(select(Establishment).where(func.lower(func.trim(Establishment.name)) == est_name.lower()))).scalars().first()
            new_est = None
            if est:
                if est_code and (est.code or "").strip().lower() != est_code.lower():
                    res.note = (f"“{est.name}” already exists with code “{est.code}”, but the sheet says “{est_code}”. "
                                "Use the existing code, or change it under Establishments first.")
                    continue
            else:
                if not est_code:
                    res.note = f"“{est_name}” is a new establishment — its Establishment Code is required."
                    continue
                clash = (await db.execute(select(Establishment).where(func.lower(func.trim(Establishment.code)) == est_code.lower()))).scalars().first()
                if clash:
                    res.note = f"The establishment code “{est_code}” is already used by “{clash.name}”."
                    continue
                new_est = Establishment(name=est_name, code=est_code, is_active=True)
                db.add(new_est)
                await db.flush()
                est = new_est
            if await _department_exists(db, est.id, dept_name):
                res.status, res.note = "skipped", f"{est.name} already has “{dept_name}”."
                continue
            code_clash = await _department_code_conflict(db, dept_code, dept_name)
            if code_clash:
                where = (await db.get(Establishment, code_clash.establishment_id)) if code_clash.establishment_id else None
                res.note = _code_conflict_message(dept_code, code_clash)[:-1] + (f" (in “{where.name}”)." if where else ".")
                if new_est:
                    await db.rollback()
                continue
            db.add(Department(name=dept_name, code=dept_code, establishment_id=est.id, is_active=True))
            await db.commit()
            if new_est:
                est_created += 1
            res.status = "created"
            if new_est:
                res.note = "New establishment created."
        except Exception:
            await db.rollback()
            res.status, res.note = "failed", "Could not save this row."
    return DeptBulkResult(
        total=len(results),
        created=sum(1 for x in results if x.status == "created"),
        skipped=sum(1 for x in results if x.status == "skipped"),
        failed=sum(1 for x in results if x.status == "failed"),
        establishments_created=est_created,
        results=results,
    )


@router.patch("/departments/{did}/toggle", response_model=DeptOut)
async def toggle_department(did: UUID, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    d = await db.get(Department, did)
    if not d: raise HTTPException(404, "Not found")
    d.is_active = not d.is_active
    await db.commit(); await db.refresh(d)
    return d

@router.delete("/departments/{did}", status_code=204)
async def delete_department(did: UUID, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    d = await db.get(Department, did)
    if not d: raise HTTPException(404, "Not found")
    reasons = await department_blockers(db, did)
    if reasons:
        raise blocked(
            f"Cannot delete the department “{d.name}”:",
            reasons,
            "You can hide it instead (the eye icon) — that keeps everything intact.",
        )
    try:
        await db.delete(d); await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        table = _fk_violation_table(exc)
        detail = f'Cannot delete — still referenced by the "{table}" table (outside eFMS). Toggle to hide instead.' if table \
            else "Department is still referenced elsewhere. Toggle to hide instead."
        raise HTTPException(400, detail)


class DeptRemoveIn(BaseModel):
    ids: List[UUID]


@router.post("/departments/remove")
async def remove_departments(body: DeptRemoveIn, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    """Remove several departments at once. Each is checked with the same rules
    as a single delete: one that people or files still use is NOT removed, and
    the exact reasons are returned; the others are removed. Nothing else is
    touched."""
    if not body.ids:
        raise HTTPException(400, "Choose at least one department.")
    results = []
    for did in dict.fromkeys(body.ids):
        d = await db.get(Department, did)
        if not d:
            continue
        est = await db.get(Establishment, d.establishment_id) if d.establishment_id else None
        res = {"id": str(did), "name": d.name, "establishment": est.name if est else None, "status": "blocked", "reasons": []}
        results.append(res)
        reasons = await department_blockers(db, did)
        if reasons:
            res["reasons"] = reasons
            continue
        try:
            await db.delete(d)
            await db.commit()
            res["status"] = "removed"
        except IntegrityError as exc:
            await db.rollback()
            table = _fk_violation_table(exc)
            res["reasons"] = [f'Still referenced by the "{table}" table.' if table else "Still referenced elsewhere."]
    return {
        "removed": sum(1 for r in results if r["status"] == "removed"),
        "blocked": sum(1 for r in results if r["status"] == "blocked"),
        "results": results,
    }


# ── Digital Signature Permissions ─────────────────────────────────────────────

class SignPermissionIn(BaseModel):
    can_sign: bool

class SignPermissionUserOut(BaseModel):
    id: UUID
    email: str
    full_name: str
    designation: Optional[str]
    active_role: Optional[str]
    can_sign: bool
    model_config = {"from_attributes": True}

    @classmethod
    def from_user(cls, u: User) -> "SignPermissionUserOut":
        return cls(
            id=u.id, email=u.email, full_name=u.full_name,
            designation=getattr(u, "designation", None),
            active_role=u.active_role,
            can_sign=bool(getattr(u, "can_sign", False)),
        )


@router.get("/sign-permissions", response_model=List[SignPermissionUserOut])
async def list_sign_permissions(db: AsyncSession = Depends(get_db), _=Depends(_super)):
    """Return all users who have been granted digital signature permission."""
    r = await db.execute(
        select(User).where(User.can_sign == True, User.is_active == True).order_by(User.first_name)
    )
    return [SignPermissionUserOut.from_user(u) for u in r.scalars().all()]


@router.patch("/users/{uid}/sign-permission")
async def set_sign_permission(
    uid: UUID,
    body: SignPermissionIn,
    db: AsyncSession = Depends(get_db),
    _=Depends(_super),
):
    """Grant or revoke digital signature permission for a user."""
    user = await db.get(User, uid)
    if not user:
        raise HTTPException(404, "User not found.")
    user.can_sign = body.can_sign  # type: ignore[attr-defined]
    await db.commit()
    action = "granted" if body.can_sign else "revoked"
    return {"message": f"Signature permission {action} for {user.full_name}."}
