"""Docket: department-wide file queue. Release only by original creator."""
from uuid import UUID
from datetime import datetime, timezone
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel

from app.db.base import get_db
from app.core.dependencies import get_current_verified_user
from app.models.user import User
from app.models.efms import EfmsFile
from app.models.efms_extra import Docket, FileRemark

router = APIRouter(prefix="/docket", tags=["Docket"])


# ── Docket: all files in my department's queue ────────────────────────────────

@router.get("", response_model=List[dict])
async def my_docket(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_verified_user)):
    """Files currently forwarded TO me (I am the current holder)."""
    result = await db.execute(
        select(EfmsFile)
        .where(EfmsFile.current_holder_id == user.id)
        .order_by(EfmsFile.updated_at.desc())
    )
    files = result.scalars().all()
    from app.models.efms import RouteEntry
    out = []
    for f in files:
        # Find who last forwarded to me
        last_route = await db.execute(
            select(RouteEntry)
            .where(RouteEntry.file_id == f.id, RouteEntry.to_user_id == user.id)
            .order_by(RouteEntry.created_at.desc())
            .limit(1)
        )
        last_entry = last_route.scalar_one_or_none()
        from_user = await db.get(User, last_entry.from_user_id) if last_entry and last_entry.from_user_id else None

        out.append({
            "file_id": str(f.id),
            "ref_number": f.ref_number,
            "subject": f.subject,
            "category": f.category,
            "status": f.status.value if hasattr(f.status, "value") else str(f.status),
            "priority": f.priority.value if hasattr(f.priority, "value") else str(f.priority),
            "created_by": str(f.created_by),
            "current_holder_id": str(f.current_holder_id) if f.current_holder_id else None,
            "updated_at": f.updated_at.isoformat() if f.updated_at else None,
            "created_at": f.created_at.isoformat() if f.created_at else None,
            "can_release": str(f.created_by) == str(user.id),
            "from_user_name": from_user.full_name if from_user else None,
        })
    return out


# ── Release a file (only original creator) ────────────────────────────────────

@router.post("/{file_id}/release")
async def release_file(file_id: UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_verified_user)):
    file = await db.get(EfmsFile, file_id)
    if not file:
        raise HTTPException(404, "File not found.")
    if str(file.created_by) != str(user.id):
        raise HTTPException(403, "Only the original creator can release this file from docket.")

    # Upsert docket record
    existing = await db.execute(select(Docket).where(Docket.file_id == file_id))
    docket = existing.scalar_one_or_none()
    if docket:
        docket.is_released = True
        docket.released_by = user.id
        docket.released_at = datetime.now(timezone.utc)
    else:
        docket = Docket(
            file_id=file_id,
            department_id=user.department_id,
            is_released=True,
            released_by=user.id,
            released_at=datetime.now(timezone.utc),
        )
        db.add(docket)

    # Clear current_holder so the file leaves everyone's docket
    file.current_holder_id = None
    await db.commit()
    return {"released": True}


# ── Released files (visible to whole department) ──────────────────────────────

@router.get("/released", response_model=List[dict])
async def released_files(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_verified_user)):
    q = select(Docket).where(Docket.is_released == True)
    if user.department_id:
        q = q.where(Docket.department_id == user.department_id)
    result = await db.execute(q.order_by(Docket.released_at.desc()))
    dockets = result.scalars().all()
    out = []
    for d in dockets:
        file = await db.get(EfmsFile, d.file_id)
        if file:
            out.append({
                "docket_id": str(d.id),
                "file_id": str(file.id),
                "ref_number": file.ref_number,
                "subject": file.subject,
                "category": file.category,
                "status": file.status.value if hasattr(file.status, "value") else str(file.status),
                "released_at": d.released_at.isoformat() if d.released_at else None,
                "created_by": str(file.created_by),
                "can_release": False,  # Already released
            })
    return out


# ── Forwarding remarks (read-only thread — no direct messaging) ──────────────

@router.get("/remarks/{file_id}")
async def get_remarks(file_id: UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_verified_user)):
    """Returns forwarding remarks from route_entries — not a messaging thread."""
    from app.models.efms import RouteEntry
    result = await db.execute(
        select(RouteEntry).where(
            RouteEntry.file_id == file_id,
            RouteEntry.remarks != None,
        ).order_by(RouteEntry.created_at)
    )
    entries = result.scalars().all()
    out = []
    for e in entries:
        from_user = await db.get(User, e.from_user_id) if e.from_user_id else None
        to_user   = await db.get(User, e.to_user_id)   if e.to_user_id   else None
        out.append({
            "id":         str(e.id),
            "remark":     e.remarks,
            "user_id":    str(e.from_user_id) if e.from_user_id else None,
            "user_name":  from_user.full_name if from_user else "System",
            "to_user":    to_user.full_name if to_user else "—",
            "action":     e.action.value if hasattr(e.action, "value") else str(e.action),
            "created_at": e.created_at.isoformat() if e.created_at else None,
        })
    return out
