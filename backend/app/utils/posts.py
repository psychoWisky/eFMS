"""Posts: a role in a place PLUS a designation.

Normally a person holds a role once per (establishment, department). The
Super Admin can put chosen people on the "Multiple designations" list
(table multi_designation_users); only they may hold the SAME role in the SAME
place more than once, told apart by the designation text — e.g. In-charge,
Hostel and In-charge, Library. Each post keeps its own Docket / My Files (the
designation is part of the file workspace key — see app/utils/workspace.py).
"""
from typing import Optional
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.efms import EfmsFile
from app.models.user import MultiDesignationUser, User, UserRole
from app.utils.workspace import norm_designation, role_context


def desig_key(value) -> str:
    """Designation as compared for "is this the same post": trimmed, any case."""
    return (norm_designation(value) or "").lower()


async def is_multi_designation_user(db: AsyncSession, user_id: UUID) -> bool:
    return (await db.get(MultiDesignationUser, user_id)) is not None


def effective_designation(user: User, ur: UserRole) -> str:
    """What the post is called: its own designation, else the person's own."""
    return norm_designation(ur.designation) or norm_designation(user.designation) or ""


async def restamp_post_designation(
    db: AsyncSession, user: User, ur: UserRole, old: Optional[str], new: Optional[str],
) -> None:
    """A post's designation was renamed: move the files and the active
    session stamped with the old one to the new one, so nothing disappears
    from the Docket / My Files."""
    old, new = norm_designation(old), norm_designation(new)
    if old == new:
        return
    estb, dept = role_context(user, ur)
    await db.execute(
        update(EfmsFile)
        .where(EfmsFile.created_by == user.id, EfmsFile.creator_role == ur.role,
               EfmsFile.creator_establishment_id.is_not_distinct_from(estb),
               EfmsFile.creator_department_id.is_not_distinct_from(dept),
               EfmsFile.creator_designation.is_not_distinct_from(old))
        .values(creator_designation=new)
    )
    await db.execute(
        update(EfmsFile)
        .where(EfmsFile.current_holder_id == user.id, EfmsFile.current_holder_role == ur.role,
               EfmsFile.current_holder_establishment_id.is_not_distinct_from(estb),
               EfmsFile.current_holder_department_id.is_not_distinct_from(dept),
               EfmsFile.current_holder_designation.is_not_distinct_from(old))
        .values(current_holder_designation=new)
    )
    if (user.active_role == ur.role and (user.establishment_id, user.department_id) == (estb, dept)
            and norm_designation(user.active_designation) == old):
        user.active_designation = new


async def posts_of(db: AsyncSession, user_id: UUID) -> list[UserRole]:
    return (await db.execute(select(UserRole).where(UserRole.user_id == user_id))).scalars().all()
