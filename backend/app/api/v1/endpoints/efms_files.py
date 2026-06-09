"""eFMS file, notesheet, routing, and dispatch endpoints."""
import uuid as _uuid
import smtplib
from email.mime.text import MIMEText
from uuid import UUID
from datetime import datetime, timezone
from typing import Optional
import os, aiofiles
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Request
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
    FileStatus, RouteAction, DispatchMode,
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
    return result.scalars().all()


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
    return result.scalars().all()


@router.get("/{file_id}/track")
async def track_file(file_id: UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_verified_user)):
    """Returns enriched route history: who forwarded to whom (no timestamps shown in UI)."""
    from app.models.efms import RouteEntry
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
            "action":         e.action.value if hasattr(e.action, "value") else str(e.action),
            "from_user_id":   str(e.from_user_id) if e.from_user_id else None,
            "to_user_id":     str(e.to_user_id)   if e.to_user_id   else None,
            "from_user_name": from_u.full_name if from_u else "System",
            "to_user_name":   to_u.full_name   if to_u   else None,
            "remarks":        e.remarks,
            "is_current":     e.is_current,
            "created_at":     e.created_at.isoformat() if e.created_at else None,
        })
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

    # Resolve recipient — recipient_id is now a user ID directly
    recipient_name = body.recipient_name
    recipient_user_id = None
    if body.recipient_id:
        rec_user = await db.get(User, body.recipient_id)
        if rec_user:
            recipient_name = rec_user.full_name
            recipient_user_id = rec_user.id

    # File goes directly to recipient's docket; if no recipient, stays as draft with creator
    holder_id = recipient_user_id if recipient_user_id else user.id
    file_status = FileStatus.pending if recipient_user_id else FileStatus.draft

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
        current_holder_id=holder_id,
        status=file_status,
    )
    db.add(efms_file)
    await db.flush()

    notesheet = Notesheet(file_id=efms_file.id, content=body.initial_content, last_saved_by=user.id)
    db.add(notesheet)

    route = RouteEntry(
        file_id=efms_file.id,
        from_user_id=user.id,
        to_user_id=holder_id,
        action=RouteAction.forward,
        is_current=True,
    )
    db.add(route)
    await db.commit()

    creator_name = user.full_name or user.email

    # Notify the recipient user (in-app only)
    if recipient_user_id:
        await create_notification(
            db, recipient_user_id,
            f"New file forwarded to you: {ref}",
            f"{creator_name} has sent you file '{body.subject}' for review.",
            file_id=efms_file.id,
        )

    # Notify super admins
    admins = await db.execute(
        select(User).where(User.active_role.in_(["super_admin", "admin"]), User.id != user.id)
    )
    for admin in admins.scalars():
        await create_notification(
            db, admin.id,
            f"New file created: {ref}",
            f"{creator_name} created '{body.subject}' and forwarded to {recipient_name or 'self'}.",
            file_id=efms_file.id,
        )
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
    if f.status not in (FileStatus.draft, FileStatus.pending):
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

    if body.action == RouteAction.approve:
        f.status = FileStatus.approved
    elif body.action == RouteAction.reject:
        f.status = FileStatus.rejected
    elif body.action == RouteAction.return_:
        f.status = FileStatus.pending
        f.current_holder_id = body.to_user_id
    elif body.action == RouteAction.forward:
        if f.status not in (FileStatus.approved, FileStatus.rejected, FileStatus.dispatched):
            f.status = FileStatus.pending
        f.current_holder_id = body.to_user_id
    elif body.action == RouteAction.dispatch:
        f.status = FileStatus.dispatched

    if body.action in (RouteAction.approve, RouteAction.dispatch) and f.notesheet:
        f.notesheet.is_locked = True

    await db.commit()

    actor_name = user.full_name or user.email

    # In-app + email notifications
    if body.action in (RouteAction.forward, RouteAction.return_) and body.to_user_id:
        to_user = await db.get(User, body.to_user_id)
        action_label = "forwarded" if body.action == RouteAction.forward else "returned"
        await create_notification(
            db, body.to_user_id,
            f"File {action_label} to you: {f.ref_number}",
            f"{actor_name} has {action_label} '{f.subject}' to you for review.",
            file_id=file_id,
        )
        await db.commit()
        if to_user:
            remarks_line = f"\nRemarks: {body.remarks}" if body.remarks else ""
            _send_email(
                to_user.email,
                f"[AVFU eFMS] File {action_label} to you: {f.ref_number}",
                f"Dear {to_user.full_name},\n\n"
                f"{actor_name} has {action_label} the following file to you:\n\n"
                f"File No : {f.ref_number}\n"
                f"Subject : {f.subject}\n"
                f"Priority: {f.priority.value if hasattr(f.priority,'value') else f.priority}{remarks_line}\n\n"
                f"Please log in to AVFU eFMS to take action.\n\nAVFU eFMS"
            )

    elif body.action == RouteAction.approve:
        creator = await db.get(User, f.created_by)
        if creator:
            await create_notification(
                db, f.created_by,
                f"File Approved: {f.ref_number}",
                f"Your file '{f.subject}' has been approved by {actor_name}.",
                file_id=file_id,
            )
            await db.commit()
            _send_email(
                creator.email,
                f"[AVFU eFMS] File Approved: {f.ref_number}",
                f"Dear {creator.full_name},\n\n"
                f"Your file has been approved.\n\n"
                f"File No : {f.ref_number}\n"
                f"Subject : {f.subject}\n"
                f"Approved by: {actor_name}\n\n"
                f"AVFU eFMS"
            )

    elif body.action == RouteAction.reject:
        creator = await db.get(User, f.created_by)
        if creator:
            await create_notification(
                db, f.created_by,
                f"File Rejected: {f.ref_number}",
                f"Your file '{f.subject}' was rejected by {actor_name}.",
                file_id=file_id,
            )
            await db.commit()
            remarks_line = f"\nReason: {body.remarks}" if body.remarks else ""
            _send_email(
                creator.email,
                f"[AVFU eFMS] File Rejected: {f.ref_number}",
                f"Dear {creator.full_name},\n\n"
                f"Your file has been rejected.\n\n"
                f"File No : {f.ref_number}\n"
                f"Subject : {f.subject}\n"
                f"Rejected by: {actor_name}{remarks_line}\n\n"
                f"AVFU eFMS"
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
    return SignatureOut(
        id=sig.id, file_id=sig.file_id, user_id=sig.user_id,
        signer_name=signer.full_name if signer else "",
        pos_x=sig.pos_x, pos_y=sig.pos_y, page_number=sig.page_number,
        status=sig.status, signed_at=sig.signed_at, verified_at=sig.verified_at,
    )


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
