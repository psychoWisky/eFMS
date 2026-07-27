"""Super-admin endpoints: manage categories, priorities, recipients, notifications, users."""
from typing import Optional, List
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel

from app.db.base import get_db
from app.core.dependencies import require_roles, get_current_user
from app.models.user import User, SystemRole
from app.models.admin import FileCategory, FilePriority, FileRecipient, Notification
from app.models.organization import Establishment, Department

router = APIRouter(prefix="/admin", tags=["Super Admin"])
_super = require_roles(SystemRole.SUPER_ADMIN, SystemRole.ADMIN)
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
    model_config = {"from_attributes": True}

    @classmethod
    def from_user(cls, u: User):
        return cls(id=u.id, email=u.email, full_name=u.full_name,
                   active_role=u.active_role.value if u.active_role else None,
                   designation=getattr(u, "designation", None))

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


# ── Users list (for forwarding picker) ───────────────────────────────────────

@router.get("/users", response_model=List[UserOut])
async def list_users(db: AsyncSession = Depends(get_db), current_user: User = Depends(_any_role)):
    r = await db.execute(
        select(User).where(User.is_active == True, User.id != current_user.id).order_by(User.first_name)
    )
    return [UserOut.from_user(u) for u in r.scalars().all()]


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
    e = Establishment(**body.model_dump())
    db.add(e); await db.commit(); await db.refresh(e)
    return e

@router.patch("/establishments/{eid}/toggle", response_model=EstablishmentOut)
async def toggle_establishment(eid: UUID, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    e = await db.get(Establishment, eid)
    if not e: raise HTTPException(404, "Not found")
    e.is_active = not e.is_active
    await db.commit(); await db.refresh(e)
    return e

@router.delete("/establishments/{eid}", status_code=204)
async def delete_establishment(eid: UUID, db: AsyncSession = Depends(get_db), _=Depends(_super)):
    e = await db.get(Establishment, eid)
    if not e: raise HTTPException(404, "Not found")
    try:
        await db.delete(e); await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(400, "Establishment has departments or users linked. Toggle to hide instead.")


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
    d = Department(**body.model_dump())
    db.add(d); await db.commit(); await db.refresh(d)
    return d

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
    try:
        await db.delete(d); await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(400, "Department has users linked. Toggle to hide instead.")


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
            active_role=u.active_role.value if u.active_role else None,
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
