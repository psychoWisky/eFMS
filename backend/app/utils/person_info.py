"""Shared "who did this" info: name + designation + department.

Single source of truth for every endpoint that surfaces a person's name
(Track Status, Remarks, Docket, file creator/holder/recipient/signer). Batches
lookups so a request involving any number of distinct users costs exactly two
queries (users, then their departments) rather than one query per user.
"""
from typing import Iterable, Optional
from uuid import UUID

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.organization import Department


class PersonInfo(BaseModel):
    id: UUID
    full_name: str
    designation: Optional[str] = None
    department_name: Optional[str] = None
    model_config = {"from_attributes": True}


async def person_info_map(
    user_ids: Iterable[Optional[UUID]], db: AsyncSession
) -> dict[UUID, PersonInfo]:
    """Batch-fetch PersonInfo for a set of user ids in exactly two queries,
    regardless of how many distinct ids are passed in."""
    ids = {i for i in user_ids if i is not None}
    if not ids:
        return {}

    result = await db.execute(select(User).where(User.id.in_(ids)))
    users = result.scalars().all()

    dept_ids = {u.department_id for u in users if u.department_id}
    dept_names: dict[UUID, str] = {}
    if dept_ids:
        dresult = await db.execute(select(Department).where(Department.id.in_(dept_ids)))
        dept_names = {d.id: d.name for d in dresult.scalars().all()}

    return {
        u.id: PersonInfo(
            id=u.id,
            full_name=u.full_name,
            designation=u.designation,
            department_name=dept_names.get(u.department_id) if u.department_id else None,
        )
        for u in users
    }
