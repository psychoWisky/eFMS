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
from app.models.efms import EfmsFile, FileStatus
from app.models.efms_extra import Docket, FileRemark
from app.api.v1.endpoints.efms_files import (
    _load_file, _assert_tracking_access, _has_full_remark_visibility,
    _finalize_current_holder_note,
)
from app.utils.person_info import person_info_map

router = APIRouter(prefix="/docket", tags=["Docket"])


# ── Docket: all files in my department's queue ────────────────────────────────

@router.get("", response_model=List[dict])
async def my_docket(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_verified_user)):
    """Files currently forwarded TO me (I am the current holder).

    A file's creator is also its initial current_holder_id (set at creation,
    before any routing), so a never-forwarded Draft would otherwise show up
    in its own creator's Docket despite not being "received" work at all —
    excluded here via status != draft, which is equivalent to "never
    forwarded" since the first forward always flips status off draft
    (see route_file)."""
    result = await db.execute(
        select(EfmsFile)
        .where(EfmsFile.current_holder_id == user.id, EfmsFile.status != FileStatus.draft)
        .order_by(EfmsFile.updated_at.desc())
    )
    files = result.scalars().all()
    from app.models.efms import RouteEntry

    # Find who last forwarded each file to me (still one routing-history query
    # per file — unchanged, unrelated to this task), then batch-resolve all
    # those senders' name/designation/department in a single extra lookup.
    last_entry_by_file = {}
    for f in files:
        last_route = await db.execute(
            select(RouteEntry)
            .where(RouteEntry.file_id == f.id, RouteEntry.to_user_id == user.id)
            .order_by(RouteEntry.created_at.desc())
            .limit(1)
        )
        last_entry_by_file[f.id] = last_route.scalar_one_or_none()

    people = await person_info_map(
        (e.from_user_id for e in last_entry_by_file.values() if e), db
    )

    out = []
    for f in files:
        last_entry = last_entry_by_file[f.id]
        from_info = people.get(last_entry.from_user_id) if last_entry and last_entry.from_user_id else None

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
            "from_user_name": from_info.full_name if from_info else None,
            "from_user_info": from_info.model_dump() if from_info else None,
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

    # Finalize the releaser's current holding-period Notesheet — nobody
    # holds the file once released, so nothing should remain editable.
    await _finalize_current_holder_note(db, file_id, user.id)

    # Clear current_holder so the file leaves everyone's docket
    file.current_holder_id = None
    await db.commit()
    return {"released": True}


# ── Reopen a released file (only original creator) ────────────────────────────

@router.post("/{file_id}/reopen")
async def reopen_file(file_id: UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_verified_user)):
    """Reopen a file the caller both created and released. Reuses the same
    file record — no new file, no new reference number, no route entry, no
    notification, no email, no history of any kind. Exactly three fields
    change: is_released -> False, status -> active, current_holder_id ->
    the creator. Everything else (notesheet, attachments, remarks, routing
    history, created_at) is left untouched. From this point the file behaves
    like any other Active file and the existing Forward flow takes over
    unchanged.

    Deliberately does NOT proactively create a new holding-period HolderNote
    row for the creator here — the outgoing holder's row was already
    finalized at release() (see _finalize_current_holder_note there), so no
    is_current row exists for this file right now. save_my_holder_notesheet
    already creates one lazily on first save when none exists (the same
    path used for any current holder's very first save), so the end result
    is identical whether the row appears now or on first edit; special-
    casing reopen here would only duplicate that logic."""
    file = await db.get(EfmsFile, file_id)
    if not file:
        raise HTTPException(404, "File not found.")
    if str(file.created_by) != str(user.id):
        raise HTTPException(403, "Only the original creator can reopen this file.")

    docket_result = await db.execute(
        select(Docket).where(Docket.file_id == file_id, Docket.is_released == True)
    )
    docket = docket_result.scalar_one_or_none()
    if not docket:
        raise HTTPException(400, "This file is not currently released.")

    docket.is_released = False
    file.status = FileStatus.active
    file.current_holder_id = user.id
    await db.commit()
    return {"reopened": True}


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


# ── My released files (creator's own — feeds the Reopen picker only) ──────────

@router.get("/released/mine", response_model=List[dict])
async def my_released_files(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_verified_user)):
    """Released files this user both created and released. Distinct from
    /released (department-wide) — this is the exact "My Released Files" list
    used by New File -> Use Existing Released File, and must never include
    department files or files the user was only a participant on."""
    result = await db.execute(
        select(Docket)
        .where(Docket.is_released == True, Docket.released_by == user.id)
        .order_by(Docket.released_at.desc())
    )
    dockets = result.scalars().all()
    out = []
    for d in dockets:
        file = await db.get(EfmsFile, d.file_id)
        if file and file.created_by == user.id:
            out.append({
                "docket_id": str(d.id),
                "file_id": str(file.id),
                "ref_number": file.ref_number,
                "subject": file.subject,
                "category": file.category,
                "released_at": d.released_at.isoformat() if d.released_at else None,
            })
    return out


# ── Forwarding remarks (read-only thread — no direct messaging) ──────────────

@router.get("/remarks/{file_id}")
async def get_remarks(file_id: UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_verified_user)):
    """Returns forwarding remarks (route_entries.remarks) for a file.

    The current holder (or admin) sees every forwarding remark. Everyone else
    — including the creator, once they've forwarded the file on — sees only
    the remark(s) they personally authored while forwarding. Nothing else.
    If the file returns to a past holder, they regain full visibility for as
    long as they hold it, then lose it again once they forward it onward —
    this falls out naturally from _has_full_remark_visibility keying off the
    file's current_holder_id, no extra state needed.
    """
    f = await _load_file(file_id, db)
    await _assert_tracking_access(f, user, db)
    full_visibility = _has_full_remark_visibility(f, user)

    from app.models.efms import RouteEntry

    all_entries_result = await db.execute(
        select(RouteEntry)
        .where(RouteEntry.file_id == file_id)
        .order_by(RouteEntry.created_at)
    )
    all_entries: list = all_entries_result.scalars().all()

    visible_entries = [
        e for e in all_entries
        if e.remarks is not None and (full_visibility or e.from_user_id == user.id)
    ]

    person_ids = set()
    for e in visible_entries:
        person_ids.add(e.from_user_id)
        person_ids.add(e.to_user_id)
    people = await person_info_map(person_ids, db)

    out = []
    for e in visible_entries:
        from_info = people.get(e.from_user_id) if e.from_user_id else None
        to_info   = people.get(e.to_user_id)   if e.to_user_id   else None
        out.append({
            "id":         str(e.id),
            "remark":     e.remarks,
            "user_id":    str(e.from_user_id) if e.from_user_id else None,
            "user_name":  from_info.full_name if from_info else "System",
            "to_user":    to_info.full_name if to_info else "—",
            "user_info":  from_info.model_dump() if from_info else None,
            "to_user_info": to_info.model_dump() if to_info else None,
            "action":     e.action.value if hasattr(e.action, "value") else str(e.action),
            "created_at": e.created_at.isoformat() if e.created_at else None,
        })
    return out
