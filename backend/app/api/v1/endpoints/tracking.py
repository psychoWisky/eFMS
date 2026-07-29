"""File Tracking History: a dedicated, read-only module distinct from My
Files / My Docket / Track Status. One row per file the caller has ever
participated in (created it, received it, or forwarded it) — built entirely
from existing EfmsFile/RouteEntry/Docket data. No new tables, no duplicated
tracking records.
"""
from datetime import datetime, timezone
from typing import List, Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.base import get_db
from app.core.dependencies import get_current_verified_user
from app.models.user import User
from app.models.efms import EfmsFile, RouteEntry
from app.models.efms_extra import Docket
from app.utils.person_info import person_info_map

router = APIRouter(prefix="/tracking", tags=["File Tracking History"])


@router.get("/history", response_model=List[dict])
async def tracking_history(
    from_date: Optional[str] = Query(None, alias="from"),
    to_date: Optional[str] = Query(None, alias="to"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    """Every file the caller created, received, or forwarded — one row per
    file, not per movement. Ref-number search is handled client-side by the
    existing matchesRefSuffix() helper (kept out of this endpoint to avoid a
    second implementation of that matching rule); date-range presets (Today /
    This Week / ... ) are resolved to from/to on the frontend and passed
    through as plain bounds here."""
    participant_file_ids = select(RouteEntry.file_id).where(
        or_(RouteEntry.from_user_id == user.id, RouteEntry.to_user_id == user.id)
    )
    q = (
        select(EfmsFile)
        .options(selectinload(EfmsFile.route_entries))
        .where(or_(EfmsFile.created_by == user.id, EfmsFile.id.in_(participant_file_ids)))
    )
    # Bind proper tz-aware datetimes, not raw strings — asyncpg has no
    # implicit VARCHAR -> timestamptz cast for bound parameters (unlike an
    # inline SQL literal), so comparing directly against the query string
    # raises "operator does not exist: timestamp with time zone >= character
    # varying" at the database.
    if from_date:
        from_dt = datetime.fromisoformat(from_date).replace(tzinfo=timezone.utc)
        q = q.where(EfmsFile.updated_at >= from_dt)
    if to_date:
        to_dt = datetime.fromisoformat(to_date + " 23:59:59").replace(tzinfo=timezone.utc)
        q = q.where(EfmsFile.updated_at <= to_dt)
    q = q.order_by(EfmsFile.updated_at.desc())

    result = await db.execute(q)
    files = result.scalars().all()

    file_ids = [f.id for f in files]
    released_ids: set = set()
    if file_ids:
        rel_result = await db.execute(
            select(Docket.file_id).where(Docket.file_id.in_(file_ids), Docket.is_released == True)
        )
        released_ids = set(rel_result.scalars().all())

    # Batch every person referenced across every file's latest route entry
    # and current holder in one call — two queries total regardless of how
    # many files/people are involved.
    latest_entry_by_file = {}
    person_ids = set()
    for f in files:
        latest = next((e for e in f.route_entries if e.is_current), None)
        if latest is None and f.route_entries:
            latest = f.route_entries[-1]  # relationship is order_by created_at
        latest_entry_by_file[f.id] = latest
        if f.current_holder_id:
            person_ids.add(f.current_holder_id)
        if latest:
            person_ids.add(latest.from_user_id)
            person_ids.add(latest.to_user_id)
    people = await person_info_map(person_ids, db)

    out = []
    for f in files:
        latest = latest_entry_by_file[f.id]
        is_released = f.id in released_ids
        from_info = people.get(latest.from_user_id) if latest and latest.from_user_id else None
        to_info = people.get(latest.to_user_id) if latest and latest.to_user_id else None
        holder_info = people.get(f.current_holder_id) if f.current_holder_id else None
        out.append({
            "file_id": str(f.id),
            "ref_number": f.ref_number,
            "subject": f.subject,
            "status": "released" if is_released else (f.status.value if hasattr(f.status, "value") else str(f.status)),
            "current_holder_info": holder_info.model_dump() if holder_info else None,
            "from_user_info": from_info.model_dump() if from_info else None,
            "to_user_info": to_info.model_dump() if to_info else None,
            "forwarded_at": latest.created_at.isoformat() if latest else None,
            "updated_at": f.updated_at.isoformat() if f.updated_at else None,
            "created_at": f.created_at.isoformat() if f.created_at else None,
        })
    return out
