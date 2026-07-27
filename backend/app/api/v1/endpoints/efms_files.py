"""eFMS file, notesheet, routing, and dispatch endpoints."""
import uuid as _uuid
import smtplib
import urllib.parse
from email.mime.text import MIMEText
from uuid import UUID
from datetime import datetime, timezone, timedelta
from typing import Optional
import os, aiofiles
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Request
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_, func, func
from sqlalchemy.orm import selectinload
from app.core.config import settings


def _send_email(to: str, subject: str, body: str) -> None:
    """Send a plain-text email using the configured SMTP settings."""
    if not settings.SMTP_USER or not settings.SMTP_PASSWORD:
        return
    msg = MIMEText(body, "plain")
    msg["Subject"] = subject
    msg["From"] = settings.SMTP_FROM
    msg["To"] = to
    try:
        with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=10) as s:
            s.starttls()
            s.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            s.sendmail(settings.SMTP_FROM, [to], msg.as_string())
    except Exception:
        pass  # Don't fail the request if email fails

from app.db.base import get_db
from app.core.dependencies import get_current_verified_user, require_roles
from app.models.user import User, SystemRole
from app.models.efms import (
    EfmsFile, Notesheet, NotesheetVersion,
    RouteEntry, FileAttachment, DispatchRecord,
    FileStatus, RouteAction, DispatchMode, FilePriority,
)
from app.models.admin import FileRecipient
from app.schemas.efms import (
    FileCreate, FileUpdate, FileOut,
    NotesheetSave, RouteAction_ as RouteActionIn,
    DispatchCreate, DispatchOut,
    SignInitiate, SignVerify, SignatureOut,
)
from app.utils.otp import create_otp, verify_otp, send_email as _send_otp_email
from app.api.v1.endpoints.admin import create_notification

# Roles that can see ALL files (spec §13, §14)
_ADMIN_ROLES = {SystemRole.SUPER_ADMIN, SystemRole.ADMIN, SystemRole.EFMS_ADMIN, SystemRole.EFMS_OFFICER, SystemRole.REGISTRAR}

# A Draft file (metadata + notesheet) is editable for only this long after creation.
DRAFT_EDIT_WINDOW = timedelta(minutes=30)


def _draft_edit_expired(f: EfmsFile) -> bool:
    return datetime.now(timezone.utc) - f.created_at > DRAFT_EDIT_WINDOW

router = APIRouter(prefix="/efms/files", tags=["eFMS Files"])

async def _generate_ref(db: AsyncSession, dept_code: str = "GEN", category: str = "GEN") -> str:
    """Format: AVFU/DEPT(4)/YEAR/CAT(3)/SEQID"""
    year = datetime.now(timezone.utc).year
    dept_part = (dept_code[:4]).upper().ljust(4, "X")
    cat_part  = (category[:3]).upper().ljust(3, "X")
    prefix = f"AVFU/{dept_part}/{year}/{cat_part}/"
    count = await db.scalar(
        select(func.count(EfmsFile.id)).where(EfmsFile.ref_number.like(f"AVFU/{dept_part}/{year}/{cat_part}/%"))
    )
    return f"{prefix}{(count or 0) + 1:04d}"


async def _attach_is_released(files: list, db: AsyncSession) -> None:
    """Set the .is_released overlay attribute on a batch of EfmsFile rows in one query."""
    from app.models.efms_extra import Docket
    if not files:
        return
    file_ids = [f.id for f in files]
    rel_result = await db.execute(
        select(Docket.file_id).where(Docket.file_id.in_(file_ids), Docket.is_released == True)
    )
    released_ids = set(rel_result.scalars().all())
    for f in files:
        f.is_released = f.id in released_ids  # type: ignore[attr-defined]


async def _load_file(file_id: UUID, db: AsyncSession) -> EfmsFile:
    from app.models.efms_extra import Docket, FileSignature
    result = await db.execute(
        select(EfmsFile)
        .where(EfmsFile.id == file_id)
        .options(
            selectinload(EfmsFile.notesheet).selectinload(Notesheet.history),
            selectinload(EfmsFile.route_entries),
            selectinload(EfmsFile.attachments),
        )
    )
    f = result.scalar_one_or_none()
    if not f:
        raise HTTPException(status_code=404, detail="File not found.")
    docket_row = await db.execute(
        select(Docket).where(Docket.file_id == file_id, Docket.is_released == True)
    )
    f.is_released = docket_row.scalar_one_or_none() is not None  # type: ignore[attr-defined]

    # Attach signatures with signer names
    sig_rows = await db.execute(
        select(FileSignature).where(FileSignature.file_id == file_id).order_by(FileSignature.created_at)
    )
    sigs = sig_rows.scalars().all()
    enriched = []
    for s in sigs:
        signer = await db.get(User, s.user_id)
        enriched.append(SignatureOut(
            id=s.id, file_id=s.file_id, user_id=s.user_id,
            signer_name=signer.full_name if signer else "",
            pos_x=s.pos_x, pos_y=s.pos_y, page_number=s.page_number,
            status=s.status, signed_at=s.signed_at, verified_at=s.verified_at,
        ))
    f.signatures = enriched  # type: ignore[attr-defined]
    return f


# ── Files CRUD ────────────────────────────────────────────────────────────────

@router.get("", response_model=list[FileOut])
async def list_files(
    status: Optional[FileStatus] = Query(None),
    holder_id: Optional[UUID] = Query(None),
    inbox: bool = Query(False),
    outbox: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    q = select(EfmsFile).options(
        selectinload(EfmsFile.notesheet),
        selectinload(EfmsFile.route_entries),
        selectinload(EfmsFile.attachments),
    )

    is_admin = user.active_role in _ADMIN_ROLES

    if inbox:
        # Inbox: files where user is current holder (files forwarded to them)
        q = q.where(EfmsFile.current_holder_id == user.id)
    elif outbox:
        from app.models.efms_extra import Docket
        released_sub = select(Docket.file_id).where(Docket.is_released == True).scalar_subquery()
        q = q.where(EfmsFile.created_by == user.id, EfmsFile.id.not_in(released_sub))
    elif not is_admin:
        # Regular users see files they created OR files forwarded to them
        q = q.where(or_(EfmsFile.created_by == user.id, EfmsFile.current_holder_id == user.id))

    if status:
        q = q.where(EfmsFile.status == status)
    if holder_id:
        q = q.where(EfmsFile.current_holder_id == holder_id)
    result = await db.execute(q.order_by(EfmsFile.updated_at.desc()))
    files = result.scalars().all()
    await _attach_is_released(files, db)
    return files


@router.get("/search", response_model=list[FileOut])
async def search_files(
    q: Optional[str] = Query(None, description="Keyword search in subject or ref_number"),
    status: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    priority: Optional[str] = Query(None),
    from_date: Optional[str] = Query(None),
    to_date: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    from sqlalchemy import or_, and_, String, cast
    from datetime import datetime
    query = select(EfmsFile).options(
        selectinload(EfmsFile.notesheet),
        selectinload(EfmsFile.route_entries),
        selectinload(EfmsFile.attachments),
    )
    is_admin = user.active_role in _ADMIN_ROLES
    if not is_admin:
        query = query.where(or_(EfmsFile.created_by == user.id, EfmsFile.current_holder_id == user.id))
    if q:
        query = query.where(or_(EfmsFile.subject.ilike(f"%{q}%"), EfmsFile.ref_number.ilike(f"%{q}%")))
    if status:
        query = query.where(cast(EfmsFile.status, String) == status)
    if category:
        query = query.where(EfmsFile.category == category)
    if priority:
        query = query.where(cast(EfmsFile.priority, String) == priority)
    if from_date:
        query = query.where(EfmsFile.created_at >= from_date)
    if to_date:
        query = query.where(EfmsFile.created_at <= to_date + " 23:59:59")
    result = await db.execute(query.order_by(EfmsFile.updated_at.desc()).limit(100))
    files = result.scalars().all()
    await _attach_is_released(files, db)
    return files


@router.get("/{file_id}/track")
async def track_file(file_id: UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_verified_user)):
    """Returns enriched route history (forwarding chain + signature events), timestamped."""
    from app.models.efms import RouteEntry
    from app.models.efms_extra import FileRemark

    result = await db.execute(
        select(RouteEntry).where(RouteEntry.file_id == file_id).order_by(RouteEntry.created_at)
    )
    entries = result.scalars().all()
    out = []
    for e in entries:
        from_u = await db.get(User, e.from_user_id) if e.from_user_id else None
        to_u   = await db.get(User, e.to_user_id)   if e.to_user_id   else None
        out.append({
            "id":             str(e.id),
            "type":           "route",
            "action":         e.action.value if hasattr(e.action, "value") else str(e.action),
            "from_user_id":   str(e.from_user_id) if e.from_user_id else None,
            "to_user_id":     str(e.to_user_id)   if e.to_user_id   else None,
            "from_user_name": from_u.full_name if from_u else "System",
            "to_user_name":   to_u.full_name   if to_u   else None,
            "remarks":        e.remarks,
            "is_current":     e.is_current,
            "created_at":     e.created_at.isoformat() if e.created_at else None,
        })

    remark_result = await db.execute(
        select(FileRemark).where(FileRemark.file_id == file_id).order_by(FileRemark.created_at)
    )
    for r in remark_result.scalars().all():
        ru = await db.get(User, r.user_id) if r.user_id else None
        out.append({
            "id":             str(r.id),
            "type":           "sign",
            "action":         "sign",
            "from_user_id":   str(r.user_id) if r.user_id else None,
            "to_user_id":     None,
            "from_user_name": ru.full_name if ru else "System",
            "to_user_name":   None,
            "remarks":        r.remark,
            "is_current":     False,
            "created_at":     r.created_at.isoformat() if r.created_at else None,
        })

    out.sort(key=lambda x: x["created_at"] or "")
    return out


@router.get("/{file_id}", response_model=FileOut)
async def get_file(
    file_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    f = await _load_file(file_id, db)
    is_admin = user.active_role in _ADMIN_ROLES
    if not is_admin:
        # Creator or current holder always has access
        if f.created_by == user.id or f.current_holder_id == user.id:
            return f
        # Anyone who was ever in the routing chain can view
        was_participant = any(
            e.from_user_id == user.id or e.to_user_id == user.id
            for e in f.route_entries
        )
        if was_participant:
            return f
        # Dept members can view files released to their department
        if user.department_id:
            from app.models.efms_extra import Docket
            rel = await db.execute(
                select(Docket).where(
                    Docket.file_id == file_id,
                    Docket.is_released == True,
                    Docket.department_id == user.department_id,
                )
            )
            if rel.scalar_one_or_none():
                return f
        raise HTTPException(status_code=403, detail="You do not have access to this file.")
    return f


@router.post("", response_model=FileOut, status_code=201)
async def create_file(
    body: FileCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    # Get department code from user's department
    dept_code = "GEN"
    if user.department_id:
        from app.models.organization import Department
        dept = await db.get(Department, user.department_id)
        if dept and dept.code:
            dept_code = dept.code
        elif dept:
            dept_code = dept.name[:4]
    ref = await _generate_ref(db, dept_code, body.category or "GEN")

    # Resolve recipient — informational only. A draft never enters the workflow:
    # no route entry, no notification, no email, no holder transfer. The recipient
    # (if chosen) is simply stored for pre-filling the eventual First Forward.
    recipient_name = body.recipient_name
    if body.recipient_id:
        rec_user = await db.get(User, body.recipient_id)
        if rec_user:
            recipient_name = rec_user.full_name

    efms_file = EfmsFile(
        ref_number=ref,
        subject=body.subject,
        category=body.category,
        priority=body.priority,
        is_confidential=body.is_confidential,
        due_date=body.due_date,
        department_id=body.department_id,
        recipient_id=body.recipient_id,
        recipient_name=recipient_name,
        created_by=user.id,
        current_holder_id=user.id,
        status=FileStatus.draft,
    )
    db.add(efms_file)
    await db.flush()

    notesheet = Notesheet(file_id=efms_file.id, content=body.initial_content, last_saved_by=user.id)
    db.add(notesheet)
    await db.commit()

    return await _load_file(efms_file.id, db)


@router.patch("/{file_id}", response_model=FileOut)
async def update_file(
    file_id: UUID,
    body: FileUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    f = await _load_file(file_id, db)
    if f.created_by != user.id and user.active_role not in ("efms_admin", "registrar", "admin"):
        raise HTTPException(status_code=403, detail="Only the file creator can update metadata.")
    if f.status != FileStatus.draft:
        raise HTTPException(status_code=400, detail="Metadata can only be edited while the file is a Draft.")
    if _draft_edit_expired(f):
        raise HTTPException(status_code=400, detail="Draft editing window (30 minutes) has expired.")
    for field, val in body.model_dump(exclude_none=True).items():
        setattr(f, field, val)
    await db.commit()
    return await _load_file(file_id, db)


# ── Notesheet ─────────────────────────────────────────────────────────────────

@router.patch("/{file_id}/notesheet", response_model=FileOut)
async def save_notesheet(
    file_id: UUID,
    body: NotesheetSave,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    f = await _load_file(file_id, db)
    if f.notesheet and f.notesheet.is_locked:
        raise HTTPException(status_code=400, detail="Notesheet is locked and cannot be edited.")
    if f.status == FileStatus.draft:
        if _draft_edit_expired(f):
            raise HTTPException(status_code=400, detail="Draft editing window (30 minutes) has expired.")
    elif f.status != FileStatus.active:
        raise HTTPException(status_code=400, detail="Notesheet cannot be edited at this file stage.")
    if not f.notesheet:
        ns = Notesheet(file_id=file_id, content=body.content, last_saved_by=user.id)
        db.add(ns)
    else:
        # Save version snapshot
        version = NotesheetVersion(
            notesheet_id=f.notesheet.id,
            version=f.notesheet.version,
            content=f.notesheet.content,
            saved_by=user.id,
        )
        db.add(version)
        f.notesheet.content = body.content
        f.notesheet.version += 1
        f.notesheet.last_saved_by = user.id
    await db.commit()
    return await _load_file(file_id, db)


# ── Routing ───────────────────────────────────────────────────────────────────

@router.post("/{file_id}/route", response_model=FileOut)
async def route_file(
    file_id: UUID,
    body: RouteActionIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    f = await _load_file(file_id, db)

    # Current holder can always act. For released files, any dept member of the creator can forward.
    if f.current_holder_id != user.id:
        can_act = False
        if getattr(f, "is_released", False) and body.action == RouteAction.forward:
            creator = await db.get(User, f.created_by)
            if creator and creator.department_id and creator.department_id == user.department_id:
                can_act = True
        if not can_act:
            raise HTTPException(
                status_code=403,
                detail="Only the current holder (or a dept member for released files) can act on this file."
            )

    # Forward requires a destination user
    if body.action == RouteAction.forward and not body.to_user_id:
        raise HTTPException(status_code=400, detail="Please select a user to forward the file to.")

    # Confidential files may only move between the original creator and original
    # recipient. A draft created without a recipient has no partner yet — the
    # first forward establishes it; every subsequent forward is then restricted
    # to that same pair.
    if f.is_confidential and body.action == RouteAction.forward and body.to_user_id:
        if f.recipient_id is None:
            f.recipient_id = body.to_user_id
        else:
            allowed = {f.created_by, f.recipient_id} - {user.id}
            if body.to_user_id not in allowed:
                raise HTTPException(
                    status_code=403,
                    detail="Confidential files can only be forwarded between the original sender and recipient.",
                )

    for entry in f.route_entries:
        entry.is_current = False

    new_route = RouteEntry(
        file_id=file_id,
        from_user_id=user.id,
        to_user_id=body.to_user_id,
        action=body.action,
        remarks=body.remarks,
        is_current=True,
    )
    db.add(new_route)

    if body.action == RouteAction.forward:
        # Draft -> Active on first forward; later forwards stay Active.
        # A dispatched file is a separate terminal state and is left untouched.
        if f.status != FileStatus.dispatched:
            f.status = FileStatus.active
        f.current_holder_id = body.to_user_id
    elif body.action == RouteAction.dispatch:
        f.status = FileStatus.dispatched

    if body.action == RouteAction.dispatch and f.notesheet:
        f.notesheet.is_locked = True

    await db.commit()

    actor_name = user.full_name or user.email

    # In-app + email notifications
    if body.action == RouteAction.forward and body.to_user_id:
        to_user = await db.get(User, body.to_user_id)
        await create_notification(
            db, body.to_user_id,
            f"File forwarded to you: {f.ref_number}",
            f"{actor_name} has forwarded '{f.subject}' to you for review.",
            file_id=file_id,
        )
        await db.commit()
        # Email is sent only for Urgent files — Normal and Confidential (unless also
        # marked Urgent) must not trigger an email notification on forward.
        if to_user and f.priority == FilePriority.urgent:
            remarks_line = f"\nRemarks: {body.remarks}" if body.remarks else ""
            _send_email(
                to_user.email,
                f"[AVFU eFMS] File forwarded to you: {f.ref_number}",
                f"Dear {to_user.full_name},\n\n"
                f"{actor_name} has forwarded the following file to you:\n\n"
                f"File No : {f.ref_number}\n"
                f"Subject : {f.subject}\n"
                f"Priority: {f.priority.value if hasattr(f.priority,'value') else f.priority}{remarks_line}\n\n"
                f"Please log in to AVFU eFMS to take action.\n\nAVFU eFMS"
            )

    return await _load_file(file_id, db)


# ── Attachments ───────────────────────────────────────────────────────────────

@router.post("/{file_id}/attachments", status_code=201)
async def upload_attachment(
    file_id: UUID,
    request: Request,
    upload: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    f = await db.get(EfmsFile, file_id)
    if not f:
        raise HTTPException(status_code=404, detail="File not found.")

    content = await upload.read()
    stored_name = f"{_uuid.uuid4()}{_get_ext(upload.filename or '')}"

    # Save to local uploads directory
    upload_dir = os.path.abspath(settings.UPLOAD_DIR)
    os.makedirs(upload_dir, exist_ok=True)
    dest = os.path.join(upload_dir, stored_name)
    async with aiofiles.open(dest, "wb") as out:
        await out.write(content)

    attachment = FileAttachment(
        file_id=file_id,
        original_name=upload.filename or stored_name,
        stored_name=stored_name,
        file_size=len(content),
        mime_type=upload.content_type,
        uploaded_by=user.id,
    )
    db.add(attachment)
    await db.commit()
    await db.refresh(attachment)

    base_url = str(request.base_url).rstrip("/")
    return {
        "id": str(attachment.id),
        "original_name": attachment.original_name,
        "file_size": attachment.file_size,
        "mime_type": attachment.mime_type,
        "url": f"{base_url}/uploads/{stored_name}",
    }


@router.delete("/{file_id}/attachments/{att_id}", status_code=204)
async def delete_attachment(
    file_id: UUID,
    att_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    att = await db.get(FileAttachment, att_id)
    if not att or att.file_id != file_id:
        raise HTTPException(status_code=404, detail="Attachment not found.")
    # Remove file from disk
    dest = os.path.join(os.path.abspath(settings.UPLOAD_DIR), att.stored_name)
    if os.path.exists(dest):
        os.remove(dest)
    await db.delete(att)
    await db.commit()


@router.get("/{file_id}/attachments/{att_id}/view")
async def view_attachment(
    file_id: UUID,
    att_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Serve attachment inline so the browser opens it in a new tab.
    No auth required — stored_name is an unguessable UUID, matching the
    existing StaticFiles security posture."""
    att = await db.get(FileAttachment, att_id)
    if not att or att.file_id != file_id:
        raise HTTPException(status_code=404, detail="Attachment not found.")
    path = os.path.join(os.path.abspath(settings.UPLOAD_DIR), att.stored_name)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File not found on disk.")
    # No Content-Disposition header — browser renders inline using its native viewer.
    # Any Content-Disposition presence (even "inline") can trigger downloads in some browsers.
    return FileResponse(
        path,
        media_type=att.mime_type or "application/octet-stream",
    )


@router.get("/{file_id}/attachments/{att_id}/download")
async def download_attachment(
    file_id: UUID,
    att_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Force-download attachment with the original filename and UTF-8 encoding."""
    att = await db.get(FileAttachment, att_id)
    if not att or att.file_id != file_id:
        raise HTTPException(status_code=404, detail="Attachment not found.")
    path = os.path.join(os.path.abspath(settings.UPLOAD_DIR), att.stored_name)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File not found on disk.")
    encoded_name = urllib.parse.quote(att.original_name, safe="")
    return FileResponse(
        path,
        media_type=att.mime_type or "application/octet-stream",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}",
        },
    )


# ── Digital Signature ─────────────────────────────────────────────────────────

@router.post("/{file_id}/sign", response_model=dict, status_code=201)
async def initiate_sign(
    file_id: UUID,
    body: SignInitiate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    """Place a pending signature stamp and send OTP to user's email."""
    if not getattr(user, "can_sign", False):
        raise HTTPException(status_code=403, detail="You do not have permission to sign documents.")

    f = await db.get(EfmsFile, file_id)
    if not f:
        raise HTTPException(status_code=404, detail="File not found.")
    if f.current_holder_id != user.id:
        raise HTTPException(status_code=403, detail="You can only sign a file that is currently forwarded to you.")

    from app.models.efms_extra import FileSignature

    existing = await db.execute(
        select(FileSignature).where(FileSignature.file_id == file_id, FileSignature.user_id == user.id)
    )
    existing_sigs = existing.scalars().all()
    if any(s.status == "verified" for s in existing_sigs):
        raise HTTPException(status_code=400, detail="You have already signed this document.")

    # Drop any stale pending placements from this user before placing a new one
    for s in existing_sigs:
        if s.status == "pending":
            await db.delete(s)

    sig = FileSignature(
        file_id=file_id,
        user_id=user.id,
        pos_x=body.pos_x,
        pos_y=body.pos_y,
        page_number=body.page_number,
        status="pending",
    )
    db.add(sig)
    await db.commit()
    await db.refresh(sig)

    code = await create_otp(db, user.email, "email")
    _send_otp_email(
        user.email,
        f"[AVFU eFMS] Signature OTP for {f.ref_number}",
        f"Dear {user.full_name},\n\n"
        f"You are signing file: {f.ref_number} — {f.subject}\n"
        f"Signature position: Page {body.page_number}, X={body.pos_x:.1f}%, Y={body.pos_y:.1f}%\n\n"
        f"Your verification OTP is:  {code}\n\n"
        f"This OTP expires in 10 minutes. Do not share it with anyone.\n\nAVFU eFMS"
    )
    return {"signature_id": str(sig.id), "message": f"OTP sent to {user.email}"}


@router.post("/{file_id}/sign/{signature_id}/verify", response_model=SignatureOut)
async def verify_sign(
    file_id: UUID,
    signature_id: UUID,
    body: SignVerify,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    """Verify OTP and mark signature as verified (? → ✓)."""
    from app.models.efms_extra import FileSignature
    sig = await db.get(FileSignature, signature_id)
    if not sig or sig.file_id != file_id:
        raise HTTPException(status_code=404, detail="Signature not found.")
    if sig.user_id != user.id:
        raise HTTPException(status_code=403, detail="This signature does not belong to you.")
    if sig.status == "verified":
        raise HTTPException(status_code=400, detail="Signature already verified.")

    ok = await verify_otp(db, user.email, "email", body.otp_code)
    if not ok:
        raise HTTPException(status_code=400, detail="Invalid or expired OTP. Please try again.")

    sig.status = "verified"
    sig.verified_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(sig)

    signer = await db.get(User, sig.user_id)
    signer_label = signer.full_name if signer and signer.full_name else (signer.email if signer else user.email)

    await _create_signed_copy_and_track(db, file_id, sig, signer_label, user)

    return SignatureOut(
        id=sig.id, file_id=sig.file_id, user_id=sig.user_id,
        signer_name=signer.full_name if signer else "",
        pos_x=sig.pos_x, pos_y=sig.pos_y, page_number=sig.page_number,
        status=sig.status, signed_at=sig.signed_at, verified_at=sig.verified_at,
    )


async def _create_signed_copy_and_track(db: AsyncSession, file_id: UUID, sig, signer_label: str, user: User) -> None:
    """After a signature is OTP-verified: stamp a signed copy of the original
    attachment, surface it under "Files attached", and record a tracking
    entry so it shows up in the file's Track Status history."""
    from app.models.efms_extra import FileRemark
    from app.utils.signing import generate_signed_copy

    att_result = await db.execute(
        select(FileAttachment).where(FileAttachment.file_id == file_id).order_by(FileAttachment.created_at)
    )
    attachments = att_result.scalars().all()
    source = attachments[0] if attachments else None

    if source:
        upload_dir = os.path.abspath(settings.UPLOAD_DIR)
        src_path = os.path.join(upload_dir, source.stored_name)
        ext = _get_ext(source.original_name) or _get_ext(source.stored_name)
        base_name = os.path.splitext(source.original_name)[0]
        signed_display_name = f"{base_name}_signed{ext}"

        try:
            async with aiofiles.open(src_path, "rb") as fh:
                content = await fh.read()

            signed_bytes = generate_signed_copy(
                content, ext,
                pos_x=sig.pos_x, pos_y=sig.pos_y, page_number=sig.page_number,
                signer_name=signer_label, timestamp=sig.verified_at,
            )

            new_stored_name = f"{_uuid.uuid4()}{ext}"
            dest = os.path.join(upload_dir, new_stored_name)
            async with aiofiles.open(dest, "wb") as out:
                await out.write(signed_bytes)

            existing_signed = next((a for a in attachments if a.original_name == signed_display_name), None)
            if existing_signed:
                old_path = os.path.join(upload_dir, existing_signed.stored_name)
                if os.path.exists(old_path):
                    try:
                        os.remove(old_path)
                    except OSError:
                        pass
                existing_signed.stored_name = new_stored_name
                existing_signed.file_size = len(signed_bytes)
            else:
                db.add(FileAttachment(
                    file_id=file_id,
                    original_name=signed_display_name,
                    stored_name=new_stored_name,
                    file_size=len(signed_bytes),
                    mime_type=source.mime_type,
                    uploaded_by=user.id,
                ))
        except (OSError, ValueError):
            pass  # Original missing or unsupported file type — skip generating a stamped copy

        db.add(FileRemark(
            file_id=file_id,
            user_id=user.id,
            remark=f"{source.original_name} signed by {signer_label}",
        ))
        await db.commit()


# ── Dispatch ──────────────────────────────────────────────────────────────────

dispatch_router = APIRouter(prefix="/efms/dispatch", tags=["eFMS Dispatch"])

@dispatch_router.get("", response_model=list[DispatchOut])
async def list_dispatches(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_roles("dispatch_officer", "efms_admin", "registrar", "admin")),
):
    result = await db.execute(select(DispatchRecord).order_by(DispatchRecord.dispatched_at.desc()))
    return result.scalars().all()


@dispatch_router.post("/{file_id}", response_model=DispatchOut, status_code=201)
async def dispatch_file(
    file_id: UUID,
    body: DispatchCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_roles("dispatch_officer", "efms_admin", "registrar")),
):
    f = await db.get(EfmsFile, file_id)
    if not f:
        raise HTTPException(status_code=404, detail="File not found.")
    if f.status == FileStatus.dispatched:
        raise HTTPException(status_code=400, detail="File has already been dispatched.")
    existing = await db.scalar(select(DispatchRecord).where(DispatchRecord.file_id == file_id))
    if existing:
        raise HTTPException(status_code=409, detail="Dispatch record already exists for this file.")

    year = datetime.now(timezone.utc).year
    seq = await db.scalar(select(func.count()).select_from(DispatchRecord)) or 0
    dispatch_no = f"AVFU/DISP/{year}/{seq + 1:04d}"

    dispatch = DispatchRecord(
        file_id=file_id,
        dispatch_no=dispatch_no,
        mode=body.mode,
        recipient=body.recipient,
        address=body.address,
        tracking_ref=body.tracking_ref,
        remarks=body.remarks,
        dispatched_by=user.id,
        dispatched_at=datetime.now(timezone.utc),
    )
    db.add(dispatch)
    f.status = FileStatus.dispatched
    await db.commit()
    await db.refresh(dispatch)
    return dispatch


def _get_ext(filename: str) -> str:
    idx = filename.rfind(".")
    return filename[idx:] if idx >= 0 else ""


# Import func for dispatch_no sequence
from sqlalchemy import func
