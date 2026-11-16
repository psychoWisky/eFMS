"""Admin → Multiple designations.

A person normally holds a role once per establishment/department. Some people
are, for example, In-charge of several things in ONE establishment (often with
no department). For those people only, the Super Admin allows the same role in
the same place more than once; the posts themselves are then given in Edit User
(each told apart by its designation, each with its own Docket / My Files).

  GET    /admin/multi-designation                  allowed people + their posts
  POST   /admin/multi-designation/users            allow one or many people
  DELETE /admin/multi-designation/users/{user_id}  stop allowing (not while they hold duplicates)
"""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.v1.endpoints.auth import _pretty_role_name
from app.core.dependencies import require_roles
from app.db.base import get_db
from app.models.user import MultiDesignationUser, SystemRole, User, UserRole
from app.utils.posts import desig_key, effective_designation
from app.utils.workspace import role_context

router = APIRouter(prefix="/admin/multi-designation", tags=["Multiple designations"])
_super = require_roles(SystemRole.SUPER_ADMIN)


class AllowIn(BaseModel):
    user_ids: list[UUID] = Field(..., min_length=1, max_length=200)


async def _load_user(db: AsyncSession, uid: UUID) -> User:
    u = (await db.execute(
        select(User).options(
            selectinload(User.roles).selectinload(UserRole.establishment),
            selectinload(User.roles).selectinload(UserRole.department),
            selectinload(User.establishment), selectinload(User.department),
        ).where(User.id == uid).execution_options(populate_existing=True)
    )).scalar_one_or_none()
    if not u or u.origin_user_id is not None:
        raise HTTPException(404, "User not found.")
    return u


def _place_key(user: User, ur: UserRole) -> tuple:
    return (ur.role, *role_context(user, ur))


def _post_out(user: User, ur: UserRole, shared: bool) -> dict:
    estb, dept = role_context(user, ur)
    return {
        "id": str(ur.id), "role": ur.role, "role_label": _pretty_role_name(ur.role),
        "establishment_id": str(estb) if estb else None,
        "establishment_name": (ur.establishment.name if ur.establishment else (user.establishment.name if user.establishment and user.establishment_id == estb else None)),
        "department_id": str(dept) if dept else None,
        "department_name": (ur.department.name if ur.department else (user.department.name if user.department and user.department_id == dept else None)),
        "designation": ur.designation,
        "effective_designation": effective_designation(user, ur) or None,
        # another post of the same role in the same place exists
        "shared_place": shared,
        "is_active_post": user.active_role == ur.role and (user.establishment_id, user.department_id) == (estb, dept)
                          and desig_key(user.active_designation) == desig_key(ur.designation),
    }


def _user_out(user: User) -> dict:
    counts: dict[tuple, int] = {}
    for ur in user.roles:
        counts[_place_key(user, ur)] = counts.get(_place_key(user, ur), 0) + 1
    posts = [_post_out(user, ur, counts[_place_key(user, ur)] > 1) for ur in user.roles if ur.role != SystemRole.SUPER_ADMIN]
    posts.sort(key=lambda p: (p["establishment_name"] or "", p["department_name"] or "", p["role_label"], p["designation"] or ""))
    return {
        "user": {"id": str(user.id), "full_name": user.full_name, "email": user.email,
                 "designation": user.designation, "is_active": user.is_active},
        "posts": posts,
        "duplicate_places": sum(1 for c in counts.values() if c > 1),
    }


@router.get("")
async def list_allowed(db: AsyncSession = Depends(get_db), _: User = Depends(_super)):
    ids = (await db.execute(select(MultiDesignationUser.user_id))).scalars().all()
    if not ids:
        return []
    users = (await db.execute(
        select(User).options(
            selectinload(User.roles).selectinload(UserRole.establishment),
            selectinload(User.roles).selectinload(UserRole.department),
            selectinload(User.establishment), selectinload(User.department),
        ).where(User.id.in_(ids))
    )).scalars().unique().all()
    return sorted((_user_out(u) for u in users), key=lambda o: o["user"]["full_name"].lower())


@router.post("/users", status_code=201)
async def allow_users(body: AllowIn, db: AsyncSession = Depends(get_db), admin: User = Depends(_super)):
    """Allow several people at once."""
    added, skipped = [], []
    for uid in dict.fromkeys(body.user_ids):
        u = await _load_user(db, uid)
        if u.is_retired or not u.is_active:
            skipped.append(f"{u.full_name} (not active)")
            continue
        if await db.get(MultiDesignationUser, u.id):
            skipped.append(f"{u.full_name} (already on the list)")
            continue
        db.add(MultiDesignationUser(user_id=u.id, created_by=admin.id))
        added.append(u.full_name)
    await db.commit()
    return {"added": added, "skipped": skipped}


@router.delete("/users/{user_id}", status_code=204)
async def disallow_user(user_id: UUID, db: AsyncSession = Depends(get_db), _: User = Depends(_super)):
    row = await db.get(MultiDesignationUser, user_id)
    if not row:
        raise HTTPException(404, "This person is not on the list.")
    u = await _load_user(db, user_id)
    out = _user_out(u)
    shared = [p for p in out["posts"] if p["shared_place"]]
    if shared:
        lines = [f"• {p['role_label']} — {' / '.join(x for x in (p['establishment_name'], p['department_name']) if x) or 'no place'} — {p['effective_designation'] or '—'}" for p in shared]
        raise HTTPException(
            409,
            f"{u.full_name} still holds the same role more than once in the same place:\n" + "\n".join(lines) +
            "\nRemove the extra ones first, then take them off the list.",
        )
    await db.delete(row)
    await db.commit()


