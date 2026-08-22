"""eFMS file, notesheet, routing, and dispatch endpoints."""
import uuid as _uuid
import smtplib
import urllib.parse
import io
import zipfile
from html import escape as _escape_html
from email.mime.text import MIMEText
from uuid import UUID
from datetime import datetime, timezone, timedelta
from typing import Optional
import os, aiofiles
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Request
from fastapi.responses import FileResponse, Response
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
from app.core.dependencies import get_current_verified_user
from app.models.user import User
from app.models.efms import (
    EfmsFile, Notesheet, NotesheetVersion, HolderNote,
    RouteEntry, FileAttachment, DispatchRecord,
    FileStatus, RouteAction, DispatchMode, FilePriority,
)
from app.models.admin import FileRecipient
from app.schemas.efms import (
    FileCreate, FileUpdate, FileOut,
    NotesheetSave, RouteAction_ as RouteActionIn,
    DispatchCreate, DispatchOut,
    SignInitiate, SignVerify, SignatureOut,
    HolderNotesheetOut, HolderNotesheetUpdate,
)
from app.utils.otp import create_otp, verify_otp, send_email as _send_otp_email
from app.utils.person_info import PersonInfo, person_info_map
from app.api.v1.endpoints.admin import create_notification

# SUPER_ADMIN is the only globally privileged role — see User.is_super_admin.
# No other role (ADMIN, EFMS_ADMIN, EFMS_OFFICER, REGISTRAR, ...) bypasses
# normal file-level authorization; they are all normal users for this purpose.

# A Draft file (metadata + notesheet) is editable for only this long after creation.
DRAFT_EDIT_WINDOW = timedelta(minutes=30)

# An uploaded attachment may only be deleted by its uploader within this long
# of the upload — reuses the same "created_at + window" pattern as DRAFT_EDIT_WINDOW.
ATTACHMENT_DELETE_WINDOW = timedelta(minutes=5)

# Reused wherever a real .docx (native or converted-from-.doc) is served/stored,
# so the exact MIME string only lives in one place.
DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def _draft_edit_expired(f: EfmsFile) -> bool:
    return datetime.now(timezone.utc) - f.created_at > DRAFT_EDIT_WINDOW


def _attachment_delete_expired(att: FileAttachment) -> bool:
    return datetime.now(timezone.utc) - att.created_at > ATTACHMENT_DELETE_WINDOW

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
    docket = docket_row.scalar_one_or_none()
    f.is_released = docket is not None  # type: ignore[attr-defined]
    f.released_at = docket.released_at if docket else None  # type: ignore[attr-defined]

    sig_rows = await db.execute(
        select(FileSignature).where(FileSignature.file_id == file_id).order_by(FileSignature.created_at)
    )
    sigs = sig_rows.scalars().all()

    # Batch every person referenced anywhere on this file (creator, current
    # holder, recipient, each route-entry sender/receiver, each signer) into a
    # single lookup — two queries total (users, departments), no matter how
    # many people are involved.
    person_ids = {f.created_by, f.current_holder_id, f.recipient_id}
    if docket and docket.released_by:
        person_ids.add(docket.released_by)
    for e in f.route_entries:
        person_ids.add(e.from_user_id)
        person_ids.add(e.to_user_id)
    for s in sigs:
        person_ids.add(s.user_id)
    people = await person_info_map(person_ids, db)

    f.creator_info = people.get(f.created_by)  # type: ignore[attr-defined]
    f.current_holder_info = people.get(f.current_holder_id) if f.current_holder_id else None  # type: ignore[attr-defined]
    f.recipient_info = people.get(f.recipient_id) if f.recipient_id else None  # type: ignore[attr-defined]
    f.released_by_info = people.get(docket.released_by) if docket and docket.released_by else None  # type: ignore[attr-defined]

    for e in f.route_entries:
        e.from_user_info = people.get(e.from_user_id) if e.from_user_id else None  # type: ignore[attr-defined]
        e.to_user_info = people.get(e.to_user_id) if e.to_user_id else None  # type: ignore[attr-defined]

    enriched = []
    for s in sigs:
        signer_info = people.get(s.user_id)
        enriched.append(SignatureOut(
            id=s.id, file_id=s.file_id, user_id=s.user_id,
            signer_name=signer_info.full_name if signer_info else "",
            signer_info=signer_info,
            pos_x=s.pos_x, pos_y=s.pos_y, page_number=s.page_number,
            status=s.status, signed_at=s.signed_at, verified_at=s.verified_at,
        ))
    f.signatures = enriched  # type: ignore[attr-defined]
    return f


async def _assert_full_file_access(f: EfmsFile, user: User, db: AsyncSession) -> None:
    """Strict/full file-access check — raises 403 unless the user is an
    admin, the CURRENT holder (file.current_holder_id == user.id, and
    nothing else), or a department member viewing a file released to their
    department. This is the boundary for actually opening/using a file:
    GET /efms/files/{id}, notesheet download, and (transitively, since they
    all route through GET /efms/files/{id}) notification click-through,
    direct file URLs, and Search -> View.

    Deliberately narrower than _assert_tracking_access below: being the
    creator or a past routing participant (someone the file passed through
    on its way to its current holder) does NOT grant full access once the
    file has moved on — only the live current_holder_id counts, per the
    project's current-holder-based access model. A file's creator is also
    its current_holder_id while it's still a Draft (set that way at
    creation and never reassigned until the first forward), so this still
    covers the "creator viewing their own still-held draft" case for free —
    it only stops covering them once they've actually forwarded it."""
    if user.is_super_admin:
        return
    if f.current_holder_id == user.id:
        return
    if user.department_id:
        from app.models.efms_extra import Docket
        rel = await db.execute(
            select(Docket).where(
                Docket.file_id == f.id,
                Docket.is_released == True,
                Docket.department_id == user.department_id,
            )
        )
        if rel.scalar_one_or_none():
            return
    raise HTTPException(status_code=403, detail="You don't have access to view this file.")


async def _assert_tracking_access(f: EfmsFile, user: User, db: AsyncSession) -> None:
    """Broader, historical/audit access check — raises 403 unless the user is
    an admin, the current holder, a past participant in the routing chain
    (the file passed through their hands at some point), or a department
    member of a file released to their department.

    This is intentionally broader than _assert_full_file_access: a user who
    forwarded a file onward and is no longer its current holder should still
    be able to see it in Tracking History (their own remark, and the
    movement/audit trail), even though they can no longer fully open the
    file. Used by track_file and get_remarks — never by anything that
    returns the initial notesheet or attachments."""
    if user.is_super_admin:
        return
    if f.created_by == user.id or f.current_holder_id == user.id:
        return
    was_participant = any(
        e.from_user_id == user.id or e.to_user_id == user.id
        for e in f.route_entries
    )
    if was_participant:
        return
    if user.department_id:
        from app.models.efms_extra import Docket
        rel = await db.execute(
            select(Docket).where(
                Docket.file_id == f.id,
                Docket.is_released == True,
                Docket.department_id == user.department_id,
            )
        )
        if rel.scalar_one_or_none():
            return
    raise HTTPException(status_code=403, detail="You do not have access to this file.")


def _has_full_remark_visibility(f: EfmsFile, viewer: User) -> bool:
    """True if `viewer` sees every forwarding remark and forwarding attachment
    on this file: admins, and whoever currently holds the file. Everyone else
    (creator included, once they've forwarded it on) sees only their own.

    This is the single source of truth for the remarks/forwarding-attachment
    visibility rule — reused by _visible_file (for get_file/create_file/
    update_file/save_notesheet/route_file) and by get_remarks, so the rule
    can never drift between them. Tracking History (track_file and
    /{file_id}/track/notesheet) uses the broader _has_full_tracking_visibility
    below instead, which wraps this function rather than duplicating it.

    Because it keys off f.current_holder_id (already updated on every forward,
    including a return-forward back to a past holder), a future Reopen feature
    that hands current_holder_id back to the creator gets full visibility for
    free — no change to this function would be needed.
    """
    return viewer.is_super_admin or f.current_holder_id == viewer.id


def _has_full_tracking_visibility(f: EfmsFile, viewer: User) -> bool:
    """Full-visibility rule specifically for Tracking History (track_file and
    /{file_id}/track/notesheet) — deliberately broader than
    _has_full_remark_visibility: on top of admins and the current holder, the
    file's creator also gets full visibility once the file has been
    released. A file can only ever be released by its own creator
    (docket.release_file), and f.is_released is the same overlay attribute
    _load_file already computes from the Docket table — no new release
    mechanism, no new query, no duplicated release logic."""
    if _has_full_remark_visibility(f, viewer):
        return True
    return bool(getattr(f, "is_released", False)) and f.created_by == viewer.id


def _first_forward_time(route_entries) -> Optional[datetime]:
    """Earliest created_at across a file's route entries — the instant it left
    Draft. Attachments uploaded strictly before this are the permanent
    "original" attachments from Draft creation; anything at/after is a
    forwarding attachment, attributable to whoever uploaded it. Returns None
    for a file that has never been forwarded (still Draft) — callers should
    treat that as "everything is original"."""
    times = [e.created_at for e in route_entries if e.created_at is not None]
    return min(times) if times else None


async def _has_attachment_access(f: EfmsFile, att: FileAttachment, user: User, db: AsyncSession) -> bool:
    """Per-attachment authorization — deliberately NOT the same gate as
    _assert_full_file_access. A previous holder (including the creator, once
    they've forwarded the file onward) can no longer fully open the file,
    but may still be entitled to specific attachments: exactly the same
    subset _visible_file already computes when filtering the attachments
    LIST for a non-full-visibility viewer (pre-first-forward "original"
    attachments if they're the creator, or anything they personally
    uploaded). This mirrors that existing rule at the individual-resource
    level instead of only at the list level, since the list-level filter
    alone does nothing to stop a direct request for the attachment's own
    view/download URL.

    Admins and the current holder always see every attachment on the file
    (matches _has_full_remark_visibility, the established full-visibility
    rule already used for remarks and the attachments list)."""
    if user.is_super_admin:
        return True
    if f.current_holder_id == user.id:
        return True
    if att.uploaded_by == user.id:
        return True
    first_fwd = _first_forward_time(f.route_entries)
    is_original = first_fwd is None or att.created_at < first_fwd
    if is_original and f.created_by == user.id:
        return True
    if is_original and user.department_id:
        from app.models.efms_extra import Docket
        rel = await db.execute(
            select(Docket).where(
                Docket.file_id == f.id,
                Docket.is_released == True,
                Docket.department_id == user.department_id,
            )
        )
        if rel.scalar_one_or_none():
            return True
    return False


async def _assert_attachment_access(f: EfmsFile, att: FileAttachment, user: User, db: AsyncSession) -> None:
    if not await _has_attachment_access(f, att, user, db):
        raise HTTPException(status_code=403, detail="You don't have access to this attachment.")


def _visible_file(f: EfmsFile, viewer: User, *, full_access: bool = True) -> FileOut:
    """Viewer-scoped serialization of a file. The routing-chain skeleton
    (who/whom/when/action) is always intact — forwarding attachments and
    remark text are filtered per _has_full_remark_visibility, exactly as
    before.

    `full_access` defaults to True because every current caller
    (create_file/update_file/save_notesheet/route_file, and get_file which
    passes it explicitly) has already independently verified the viewer may
    fully open this file (via _assert_full_file_access or an equivalent
    current-holder-only check) before ever reaching this function. When a
    caller passes full_access=False — a viewer who only cleared
    _assert_tracking_access, not the strict check — the initial notesheet
    content is nulled out as well: it must never reach a past participant
    who is no longer the current holder, even inside a FileOut payload
    otherwise built for another purpose.

    IMPORTANT: this filters a *detached Pydantic copy*, never the live ORM
    object. EfmsFile.attachments and .route_entries are both mapped with
    cascade="all, delete-orphan" — reassigning those relationship collections
    directly on `f` would mark excluded rows as orphans and delete them from
    the database on the next commit. FileOut.model_validate(f) produces an
    independent copy that is safe to filter/mutate freely.
    """
    payload = FileOut.model_validate(f)
    if not full_access:
        payload.notesheet = None
    if _has_full_remark_visibility(f, viewer):
        return payload
    first_fwd = _first_forward_time(f.route_entries)
    payload.attachments = [
        a for a in payload.attachments
        if first_fwd is None or a.created_at < first_fwd or a.uploaded_by == viewer.id
    ]
    for entry in payload.route_entries:
        if entry.from_user_id != viewer.id:
            entry.remarks = None
    return payload


def _list_safe_file(f: EfmsFile) -> FileOut:
    """Serialization for list/search endpoints (list_files, search_files) —
    these return many files at once without running _assert_full_file_access
    per file (a user's own outbox, for instance, deliberately includes files
    they created but can no longer fully open once forwarded away). Full
    per-file access-scoped filtering (_visible_file) is therefore not
    applicable here; instead, `notesheet` and `attachments` — the two fields
    that carry actual protected document content — are always stripped
    outright, since no list/search UI needs them (only summary fields like
    ref_number/subject/status/dates do). This closes an over-fetching gap
    where the full, unfiltered content was previously present on the wire
    for every file in the list, including ones the requesting user could not
    open individually via GET /{file_id}."""
    payload = FileOut.model_validate(f)
    payload.notesheet = None
    payload.attachments = []
    return payload


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

    is_admin = user.is_super_admin

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
    return [_list_safe_file(f) for f in files]


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
    is_admin = user.is_super_admin
    if not is_admin:
        # Current-holder only — matches _assert_full_file_access, the same
        # boundary GET /{file_id} enforces. Search must never surface a file
        # a non-admin user can no longer fully open (e.g. because they were
        # only its creator and have since forwarded it onward); historical/
        # audit access for that case belongs to File Tracking History, a
        # separate, dedicated screen, not a Search -> View bypass.
        query = query.where(EfmsFile.current_holder_id == user.id)
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
    return [_list_safe_file(f) for f in files]


@router.get("/{file_id}/track")
async def track_file(file_id: UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_verified_user)):
    """Returns enriched route history (forwarding chain + signature events), timestamped.

    Routing events themselves (who forwarded to whom, when, current holder) are
    never hidden — every authorized viewer sees the complete chain. Only the
    remark text attached to each event is filtered: full visibility for the
    current holder, the creator once the file is released, or an admin
    (_has_full_tracking_visibility) — own-remark-only for everyone else. The
    entry stays in the list either way; only its "remarks" field is blanked.

    Reachable by tracking-eligible viewers (_assert_tracking_access), not
    just the current holder — a past participant who forwarded the file
    onward must still be able to see its movement/audit history."""
    f = await _load_file(file_id, db)
    await _assert_tracking_access(f, user, db)
    full_visibility = _has_full_tracking_visibility(f, user)

    from app.models.efms import RouteEntry
    from app.models.efms_extra import FileRemark

    result = await db.execute(
        select(RouteEntry).where(RouteEntry.file_id == file_id).order_by(RouteEntry.created_at)
    )
    entries = result.scalars().all()

    remark_result = await db.execute(
        select(FileRemark).where(FileRemark.file_id == file_id).order_by(FileRemark.created_at)
    )
    remark_rows = remark_result.scalars().all()

    # Batch every person referenced across the whole timeline in one lookup
    # (two queries total) instead of one query per entry.
    person_ids = set()
    for e in entries:
        person_ids.add(e.from_user_id)
        person_ids.add(e.to_user_id)
    for r in remark_rows:
        person_ids.add(r.user_id)
    people = await person_info_map(person_ids, db)

    out = []
    for e in entries:
        from_info = people.get(e.from_user_id) if e.from_user_id else None
        to_info   = people.get(e.to_user_id)   if e.to_user_id   else None
        visible_remark = e.remarks if (full_visibility or e.from_user_id == user.id) else None
        out.append({
            "id":             str(e.id),
            "type":           "route",
            "action":         e.action.value if hasattr(e.action, "value") else str(e.action),
            "from_user_id":   str(e.from_user_id) if e.from_user_id else None,
            "to_user_id":     str(e.to_user_id)   if e.to_user_id   else None,
            "from_user_name": from_info.full_name if from_info else "System",
            "to_user_name":   to_info.full_name   if to_info   else None,
            "from_user_info": from_info.model_dump() if from_info else None,
            "to_user_info":   to_info.model_dump()   if to_info   else None,
            "remarks":        visible_remark,
            # A remark existed on this movement but was redacted from
            # "remarks" above (as opposed to no remark ever having been
            # written) — lets the frontend show "you don't have access to
            # read this" only where something is actually being withheld,
            # never as a boolean leak of the remark's own content.
            "has_remark":     e.remarks is not None,
            "is_current":     e.is_current,
            "created_at":     e.created_at.isoformat() if e.created_at else None,
        })

    for r in remark_rows:
        r_info = people.get(r.user_id) if r.user_id else None
        out.append({
            "id":             str(r.id),
            "type":           "sign",
            "action":         "sign",
            "from_user_id":   str(r.user_id) if r.user_id else None,
            "to_user_id":     None,
            "from_user_name": r_info.full_name if r_info else "System",
            "to_user_name":   None,
            "from_user_info": r_info.model_dump() if r_info else None,
            "to_user_info":   None,
            "remarks":        r.remark,
            "has_remark":     r.remark is not None,
            "is_current":     False,
            "created_at":     r.created_at.isoformat() if r.created_at else None,
        })

    out.sort(key=lambda x: x["created_at"] or "")
    return out


@router.get("/{file_id}/track/notesheet")
async def track_initial_notesheet(file_id: UUID, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_verified_user)):
    """The initial notesheet's content, scoped for Tracking History — reachable
    by any tracking-eligible viewer (_assert_tracking_access, same boundary
    as track_file). Content is included when the viewer has general full
    tracking visibility (current holder, the creator once released, or an
    admin) OR — separately — when the viewer is the file's own creator: this
    is literally their own original document, so unlike remarks-visibility
    (which is about reading OTHER people's contributions), there is no
    reason to withhold it from its own author just because the file hasn't
    been released yet. A past participant who is neither can still call
    this — they just get accessible=False and no content, so the frontend
    can render "you don't have access to read this" instead of nothing.

    GET /efms/files/{id} (get_file) already carries the notesheet for a
    current holder, but that endpoint requires _assert_full_file_access and
    is unreachable for a past participant — this is the tracking-scoped
    equivalent for just the one field Tracking History needs, not a
    duplicate of get_file."""
    f = await _load_file(file_id, db)
    await _assert_tracking_access(f, user, db)
    accessible = _has_full_tracking_visibility(f, user) or f.created_by == user.id
    has_notesheet = bool(f.notesheet and f.notesheet.content)
    return {
        "content": f.notesheet.content if (accessible and has_notesheet) else None,
        "has_notesheet": has_notesheet,
        "accessible": accessible,
    }


@router.get("/{file_id}", response_model=FileOut)
async def get_file(
    file_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    """Full file open — the current holder (or admin, or a department
    member viewing a file released to their department) only. A past
    participant who has forwarded the file onward is rejected here (see
    _assert_full_file_access); they can still reach the movement/audit
    trail via GET /{file_id}/track, which uses the broader
    _assert_tracking_access instead."""
    f = await _load_file(file_id, db)
    await _assert_full_file_access(f, user, db)
    return _visible_file(f, user, full_access=True)


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

    return _visible_file(await _load_file(efms_file.id, db), user)


@router.patch("/{file_id}", response_model=FileOut)
async def update_file(
    file_id: UUID,
    body: FileUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    f = await _load_file(file_id, db)
    if f.created_by != user.id and not user.is_super_admin:
        raise HTTPException(status_code=403, detail="Only the file creator can update metadata.")
    if f.status != FileStatus.draft:
        raise HTTPException(status_code=400, detail="Metadata can only be edited while the file is a Draft.")
    if _draft_edit_expired(f):
        raise HTTPException(status_code=400, detail="Draft editing window (30 minutes) has expired.")

    update_data = body.model_dump(exclude_none=True)
    # recipient_id is authoritative — always re-resolve recipient_name from the
    # user record (same pattern as create_file) rather than trusting whatever
    # name the client sends alongside it.
    if "recipient_id" in update_data:
        rec_user = await db.get(User, update_data["recipient_id"])
        update_data["recipient_name"] = rec_user.full_name if rec_user else update_data.get("recipient_name")
    for field, val in update_data.items():
        setattr(f, field, val)
    await db.commit()
    return _visible_file(await _load_file(file_id, db), user)


@router.delete("/{file_id}", status_code=204)
async def delete_draft_file(
    file_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    """Permanently delete an entire Draft file. Distinct from attachment
    deletion (delete_attachment above) — this removes the whole file record.
    Allowed only for the creator, only while the file is still a Draft, and
    only if it has never been forwarded. Deliberately NOT gated by
    DRAFT_EDIT_WINDOW/_draft_edit_expired (unlike metadata/notesheet editing):
    once that window closes, deletion is the creator's only remaining way to
    get rid of a draft they can no longer edit, so it must stay available for
    as long as the file is still an untouched Draft."""
    f = await _load_file(file_id, db)
    if f.created_by != user.id:
        raise HTTPException(status_code=403, detail="Only the file creator can delete this file.")
    if f.status != FileStatus.draft:
        raise HTTPException(status_code=400, detail="Only a Draft file can be deleted.")
    if f.route_entries:
        raise HTTPException(status_code=400, detail="This file has already been forwarded and can no longer be deleted.")

    # Remove attachment files from disk before the DB row (and its ORM-cascaded
    # attachment rows) disappear — same pattern as delete_attachment.
    upload_dir = os.path.abspath(settings.UPLOAD_DIR)
    for att in f.attachments:
        dest = os.path.join(upload_dir, att.stored_name)
        if os.path.exists(dest):
            os.remove(dest)

    await db.delete(f)
    await db.commit()


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
    # Notesheet.content is immutable once the file leaves Draft — a previous
    # revision briefly let the current holder of an Active file PATCH it too,
    # but that violated the business rule that the creator's initial
    # notesheet and every saved version are permanent record. Editing is
    # restricted to the file's own creator, only while it's still a Draft.
    # The current holder's own contribution lives in HolderNote (see
    # GET/PATCH /{file_id}/holder-notesheet below) — a separate, per-user
    # row, never a PATCH that overwrites this shared one.
    if f.status == FileStatus.draft:
        # Same ownership rule as update_file's metadata edit — the creator,
        # not merely the current holder (which is the same person for an
        # untouched Draft, but this must not be mistaken for holder-based
        # authorization).
        if f.created_by != user.id and not user.is_super_admin:
            raise HTTPException(status_code=403, detail="Only the file creator can edit this notesheet.")
        if _draft_edit_expired(f):
            raise HTTPException(status_code=400, detail="Draft editing window (30 minutes) has expired.")
    else:
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
    return _visible_file(await _load_file(file_id, db), user)


# ── Holder Notes (per-user Notesheet) ──────────────────────────────────────────
# Distinct from Notesheet above (the creator's single, shared, immutable-once-
# non-draft document) and from RouteEntry.remarks (a per-forward routing
# annotation). Every user who has ever held the file gets at most one
# HolderNote row per file, enforced by the (file_id, user_id) unique
# constraint. It is writable only while that user is the file's current
# holder; once forwarded away, the row is frozen (no write path ever matches
# them again) but stays visible as their historical contribution.

@router.get("/{file_id}/holder-notesheet", response_model=Optional[HolderNotesheetOut])
async def get_my_holder_notesheet(
    file_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    """The AUTHENTICATED caller's own HolderNote for this file — never
    another user's. `user_id` is always derived from the auth token, never
    accepted as a parameter, so there is no way to request someone else's
    row through this endpoint. Returns null if the caller has never saved
    one yet (the frontend starts with empty content in that case — no row is
    created until the first Save Changes)."""
    f = await _load_file(file_id, db)
    await _assert_full_file_access(f, user, db)
    result = await db.execute(
        select(HolderNote).where(HolderNote.file_id == file_id, HolderNote.user_id == user.id)
    )
    note = result.scalar_one_or_none()
    if not note:
        return None
    people = await person_info_map({note.user_id}, db)
    note.user_info = people.get(note.user_id)  # type: ignore[attr-defined]
    return note


@router.get("/{file_id}/holder-notesheets", response_model=list[HolderNotesheetOut])
async def list_holder_notesheets(
    file_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    """Every holder's Notesheet for this file THAT THIS VIEWER IS AUTHORIZED
    TO READ, oldest first — read-only history for the UI (alongside the
    creator's Notesheet above and the Track Status routing trail).

    Having "full file access" (current holder, admin, or a department member
    viewing a released file) is the boundary for reaching this endpoint at
    all — it is NOT the same thing as being allowed to read every other
    holder's individual Notesheet. Only the current holder and admins get
    that broader visibility (_has_full_remark_visibility — the same
    established rule _visible_file already uses to decide who sees every
    forwarding remark/attachment vs. just their own). Everyone else who can
    still open the file — most notably a department-released viewer — sees
    only their own row here, never another user's HolderNote. Nothing here
    is ever editable through this endpoint regardless."""
    f = await _load_file(file_id, db)
    await _assert_full_file_access(f, user, db)
    query = select(HolderNote).where(HolderNote.file_id == file_id)
    if not _has_full_remark_visibility(f, user):
        query = query.where(HolderNote.user_id == user.id)
    result = await db.execute(query.order_by(HolderNote.created_at))
    notes = result.scalars().all()
    if not notes:
        return []
    people = await person_info_map({n.user_id for n in notes}, db)
    for n in notes:
        n.user_info = people.get(n.user_id)  # type: ignore[attr-defined]
    return notes


@router.patch("/{file_id}/holder-notesheet", response_model=HolderNotesheetOut)
async def save_my_holder_notesheet(
    file_id: UUID,
    body: HolderNotesheetUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    """Upsert the AUTHENTICATED caller's own HolderNote — the persistence
    boundary for the current holder's "Save Changes" action. Deliberately
    does NOT forward the file, create a RouteEntry, change current_holder_id
    or status, or touch the shared Notesheet/any other user's HolderNote.

    Authorization is current-holder-only (or admin) — the same rule
    route_file already enforces for acting on a file at all. This is what
    makes a past holder's row permanently read-only the moment the file
    moves on: once current_holder_id no longer equals them, this check
    rejects every subsequent write attempt, including on their own
    previously-created row."""
    f = await _load_file(file_id, db)
    if f.current_holder_id != user.id and not user.is_super_admin:
        raise HTTPException(status_code=403, detail="Only the current holder can save this Notesheet.")
    result = await db.execute(
        select(HolderNote).where(HolderNote.file_id == file_id, HolderNote.user_id == user.id)
    )
    note = result.scalar_one_or_none()
    if not note:
        note = HolderNote(file_id=file_id, user_id=user.id, content=body.content)
        db.add(note)
    else:
        note.content = body.content
    await db.commit()
    await db.refresh(note)
    people = await person_info_map({user.id}, db)
    note.user_info = people.get(user.id)  # type: ignore[attr-defined]
    return note


@router.get("/{file_id}/notesheet/download")
async def download_notesheet(
    file_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    """Download the complete notesheet as a PDF. The notesheet's stored
    content already IS HTML (Tiptap output rendered read-only elsewhere via
    NOTESHEET_PROSE_CLASS) — this builds the same standalone HTML document
    as before, then converts it to PDF via convert_html_to_pdf() (the same
    LibreOffice-headless mechanism convert_doc_to_docx() already uses for
    .doc preview/signing — one conversion mechanism, not a second one).
    notesheet.content itself is only ever read here, never modified. Uses
    the same strict, current-holder-only access rule as get_file — a past
    participant who has forwarded the file onward must not be able to
    download its notesheet."""
    f = await _load_file(file_id, db)
    await _assert_full_file_access(f, user, db)
    if not f.notesheet:
        raise HTTPException(status_code=404, detail="This file has no notesheet yet.")

    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>{_escape_html(f.subject)} — Notesheet</title>
<style>
body {{ font-family: Georgia, 'Times New Roman', serif; max-width: 800px; margin: 40px auto; padding: 0 24px; color: #1a1a1a; line-height: 1.6; }}
h1 {{ font-size: 20px; }} h2 {{ font-size: 17px; }} h3 {{ font-size: 15px; }}
.meta {{ color: #666; font-size: 13px; margin-bottom: 24px; border-bottom: 1px solid #ddd; padding-bottom: 12px; }}
</style></head>
<body>
<div class="meta"><strong>{_escape_html(f.ref_number)}</strong><br>{_escape_html(f.subject)}</div>
{f.notesheet.content}
</body></html>"""

    from app.utils.doc_convert import convert_html_to_pdf, DocConversionUnavailable, DocConversionFailed
    try:
        pdf_bytes = convert_html_to_pdf(html.encode("utf-8"))
    except DocConversionUnavailable:
        raise HTTPException(status_code=503, detail="PDF generation is not available on this server.")
    except DocConversionFailed:
        raise HTTPException(status_code=422, detail="The notesheet could not be converted to PDF.")

    file_name = f"{f.ref_number.replace('/', '-')}-notesheet.pdf"
    encoded_name = urllib.parse.quote(file_name, safe="")
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}"},
    )


# ── Routing ───────────────────────────────────────────────────────────────────

@router.post("/{file_id}/route", response_model=FileOut)
async def route_file(
    file_id: UUID,
    body: RouteActionIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    f = await _load_file(file_id, db)

    # Only the current holder can act. Released files have no current holder
    # (cleared on release) and can no longer be forwarded directly — they must
    # be reopened first (POST /docket/{file_id}/reopen, creator-only), which
    # restores current_holder_id and lets the normal Forward flow take over.
    if f.current_holder_id != user.id:
        raise HTTPException(
            status_code=403,
            detail="Only the current holder can act on this file."
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
        # Normalize "" to NULL: an empty string is not the same thing as "no
        # remark" downstream — track_file's `has_remark = e.remarks is not
        # None` would treat a stored "" as "content exists but is hidden"
        # for viewers who can't see it, producing a false "you don't have
        # access to read this" for an entry that never had real content.
        # Enforced here (not just in the frontend) so the guarantee holds
        # regardless of caller.
        remarks=(body.remarks or None),
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

    return _visible_file(await _load_file(file_id, db), user)


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

    ext = _get_ext(upload.filename or "").lstrip(".").lower()
    if ext not in settings.allowed_extensions_list:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '.{ext}'. Allowed: {', '.join(settings.allowed_extensions_list)}.",
        )

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
    if att.uploaded_by != user.id:
        raise HTTPException(status_code=403, detail="Only the uploader can delete this attachment.")
    f = await db.get(EfmsFile, file_id)
    if not f or f.current_holder_id != user.id:
        raise HTTPException(status_code=403, detail="You can only delete attachments while you are the current holder of this file.")
    if _attachment_delete_expired(att):
        raise HTTPException(status_code=400, detail="Attachment deletion window (5 minutes) has expired.")
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
    user: User = Depends(get_current_verified_user),
):
    """Serve attachment inline so the browser opens it in a new tab.
    Requires authentication and per-attachment authorization
    (_assert_attachment_access) — previously this endpoint relied solely on
    stored_name being an unguessable UUID, which meant anyone who obtained
    an attachment ID by any means (a stale cached response, a shared link,
    etc.) could view it regardless of whether they still had any
    relationship to the file."""
    att = await db.get(FileAttachment, att_id)
    if not att or att.file_id != file_id:
        raise HTTPException(status_code=404, detail="Attachment not found.")
    f = await _load_file(file_id, db)
    await _assert_attachment_access(f, att, user, db)
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
    user: User = Depends(get_current_verified_user),
):
    """Force-download attachment with the original filename and UTF-8
    encoding. Requires authentication and per-attachment authorization —
    see view_attachment above for why this changed from unauthenticated."""
    att = await db.get(FileAttachment, att_id)
    if not att or att.file_id != file_id:
        raise HTTPException(status_code=404, detail="Attachment not found.")
    f = await _load_file(file_id, db)
    await _assert_attachment_access(f, att, user, db)
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


@router.get("/{file_id}/attachments/zip")
async def download_all_attachments(
    file_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    """Download every attachment ON THIS FILE THAT THIS USER IS AUTHORIZED
    TO SEE as one .zip — silently excludes any attachment
    _has_attachment_access rejects, rather than requiring all-or-nothing
    access to the whole file's attachment set. Reuses the exact same
    disk-path resolution as download_attachment for each entry (no second
    file-lookup implementation) and preserves each attachment's original
    filename inside the archive."""
    f = await _load_file(file_id, db)
    result = await db.execute(select(FileAttachment).where(FileAttachment.file_id == file_id))
    all_attachments = result.scalars().all()
    attachments = [a for a in all_attachments if await _has_attachment_access(f, a, user, db)]
    if not attachments:
        raise HTTPException(status_code=404, detail="This file has no attachments you have access to.")

    upload_dir = os.path.abspath(settings.UPLOAD_DIR)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for att in attachments:
            path = os.path.join(upload_dir, att.stored_name)
            if os.path.exists(path):
                zf.write(path, arcname=att.original_name)
    buf.seek(0)

    zip_name = f"{f.ref_number.replace('/', '-')}-attachments.zip"
    encoded_name = urllib.parse.quote(zip_name, safe="")
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{encoded_name}"},
    )


@router.get("/{file_id}/attachments/{att_id}/preview-docx")
async def preview_doc_as_docx(
    file_id: UUID,
    att_id: UUID,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    """Convert a legacy .doc attachment to .docx on the fly, purely as a
    preview artifact — the stored .doc file on disk is never modified or
    replaced (see convert_doc_to_docx). Lets the frontend reuse the exact
    same docx-preview renderer already used for native .docx attachments
    and by the eSign feature, instead of a second .doc-specific viewer.
    Requires authentication and the same per-attachment authorization as
    view_attachment/download_attachment — this serves a converted copy of
    the exact same protected bytes, so it must not be a weaker path to the
    same content."""
    att = await db.get(FileAttachment, att_id)
    if not att or att.file_id != file_id:
        raise HTTPException(status_code=404, detail="Attachment not found.")
    f = await _load_file(file_id, db)
    await _assert_attachment_access(f, att, user, db)
    if _get_ext(att.original_name).lower() != ".doc":
        raise HTTPException(status_code=400, detail="This attachment is not a legacy .doc file.")
    path = os.path.join(os.path.abspath(settings.UPLOAD_DIR), att.stored_name)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="File not found on disk.")

    async with aiofiles.open(path, "rb") as fh:
        content = await fh.read()

    from app.utils.doc_convert import convert_doc_to_docx, DocConversionUnavailable, DocConversionFailed
    try:
        docx_bytes = convert_doc_to_docx(content)
    except DocConversionUnavailable:
        raise HTTPException(status_code=503, detail="Preview conversion is not available on this server.")
    except DocConversionFailed:
        raise HTTPException(status_code=422, detail="This document could not be converted for preview.")

    return Response(
        content=docx_bytes,
        media_type=DOCX_MIME_TYPE,
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
    entry so it shows up in the file's Track Status history.

    Legacy .doc sources are converted to .docx first — via the same
    convert_doc_to_docx() used by the preview-docx endpoint, no second
    conversion implementation — since generate_signed_copy only stamps
    .pdf/.docx. The signed copy is then always saved with a real .docx
    extension/MIME type, never as .doc. The original .doc attachment is only
    ever opened for reading here; it is never written to, renamed, or removed.

    The signature itself (sig.status is already "verified" by the time this
    runs, committed in verify_sign before this is called) is a separate,
    already-completed fact and is never rolled back here. What this function
    must not do is claim a signed copy exists when one wasn't actually
    produced — so the tracking remark reflects success or failure honestly,
    and no signed-copy FileAttachment is created on failure."""
    from app.models.efms_extra import FileRemark
    from app.utils.signing import generate_signed_copy
    from app.utils.doc_convert import convert_doc_to_docx, DocConversionUnavailable, DocConversionFailed

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

        # A .doc source is always signed as a converted .docx copy, so the
        # signed artifact's extension/MIME must reflect what it actually is
        # — never re-use the source's own .doc extension/MIME here.
        is_legacy_doc = ext.lower() == ".doc"
        stamp_ext = ".docx" if is_legacy_doc else ext
        signed_mime = DOCX_MIME_TYPE if is_legacy_doc else source.mime_type
        signed_display_name = f"{base_name}_signed{stamp_ext}"

        signed_copy_created = False
        try:
            async with aiofiles.open(src_path, "rb") as fh:
                content = await fh.read()

            if is_legacy_doc:
                content = convert_doc_to_docx(content)  # original .doc bytes on disk are never touched

            signed_bytes = generate_signed_copy(
                content, stamp_ext,
                pos_x=sig.pos_x, pos_y=sig.pos_y, page_number=sig.page_number,
                signer_name=signer_label, timestamp=sig.verified_at,
            )

            new_stored_name = f"{_uuid.uuid4()}{stamp_ext}"
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
                existing_signed.mime_type = signed_mime
            else:
                db.add(FileAttachment(
                    file_id=file_id,
                    original_name=signed_display_name,
                    stored_name=new_stored_name,
                    file_size=len(signed_bytes),
                    mime_type=signed_mime,
                    uploaded_by=user.id,
                ))
            signed_copy_created = True
        except (OSError, ValueError, DocConversionUnavailable, DocConversionFailed):
            # Original missing, unsupported file type, or (for .doc) the
            # conversion tool being unavailable/failing — no signed-copy
            # attachment is created; the original source is left untouched
            # either way, since nothing above wrote to src_path.
            signed_copy_created = False

        if signed_copy_created:
            db.add(FileRemark(
                file_id=file_id,
                user_id=user.id,
                remark=f"{source.original_name} signed by {signer_label}",
            ))
        else:
            # Never claim a signed copy exists when it doesn't — the
            # signature itself is still verified, but that fact must be
            # visible in the remark instead of being indistinguishable from
            # a real signed-copy success.
            db.add(FileRemark(
                file_id=file_id,
                user_id=user.id,
                remark=f"{source.original_name}: signature verified by {signer_label}, but a signed copy could not be generated.",
            ))
        await db.commit()


# ── Dispatch ──────────────────────────────────────────────────────────────────

dispatch_router = APIRouter(prefix="/efms/dispatch", tags=["eFMS Dispatch"])

@dispatch_router.get("", response_model=list[DispatchOut])
async def list_dispatches(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(get_current_verified_user),
):
    """Dispatch is the normal file-forwarding/routing workflow, not a
    privileged function — any authenticated eFMS user may view the
    dispatch log, matching list_files/search_files elsewhere in this
    module (no role restriction, since roles carry no eFMS-workflow
    privilege beyond SUPER_ADMIN)."""
    result = await db.execute(select(DispatchRecord).order_by(DispatchRecord.dispatched_at.desc()))
    return result.scalars().all()


@dispatch_router.post("/{file_id}", response_model=DispatchOut, status_code=201)
async def dispatch_file(
    file_id: UUID,
    body: DispatchCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_verified_user),
):
    f = await db.get(EfmsFile, file_id)
    if not f:
        raise HTTPException(status_code=404, detail="File not found.")
    # Dispatch is an action taken on a file, same category as forwarding —
    # authorized by the same current-holder-or-SUPER_ADMIN rule route_file
    # already uses for every other action on a file, not by role name.
    if f.current_holder_id != user.id and not user.is_super_admin:
        raise HTTPException(status_code=403, detail="Only the current holder can dispatch this file.")
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
