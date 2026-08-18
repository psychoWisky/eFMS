"""Pydantic v2 schemas for eFMS resources."""
from __future__ import annotations
from datetime import datetime
from typing import Optional, List
from uuid import UUID
from pydantic import BaseModel, Field

from app.models.efms import FileStatus, FilePriority, RouteAction, DispatchMode
from app.utils.person_info import PersonInfo


# ── Signature schemas ─────────────────────────────────────────────────────────

class SignInitiate(BaseModel):
    pos_x: float = Field(..., ge=0, le=100)
    pos_y: float = Field(..., ge=0, le=100)
    page_number: int = Field(1, ge=1)


class SignVerify(BaseModel):
    otp_code: str = Field(..., min_length=6, max_length=6)


class SignatureOut(BaseModel):
    id: UUID
    file_id: UUID
    user_id: UUID
    signer_name: str = ""
    signer_info: Optional[PersonInfo] = None
    pos_x: float
    pos_y: float
    page_number: int
    status: str
    signed_at: Optional[datetime] = None
    verified_at: Optional[datetime] = None
    model_config = {"from_attributes": True}


class FileCreate(BaseModel):
    subject: str = Field(..., min_length=5, max_length=500)
    category: str = "general"
    priority: FilePriority = FilePriority.normal
    department_id: Optional[UUID] = None
    is_confidential: bool = False
    due_date: Optional[datetime] = None
    initial_content: str = ""
    recipient_id: Optional[UUID] = None
    recipient_name: Optional[str] = None


class FileUpdate(BaseModel):
    subject: Optional[str] = Field(None, min_length=5, max_length=500)
    category: Optional[str] = None
    priority: Optional[FilePriority] = None
    due_date: Optional[datetime] = None
    is_confidential: Optional[bool] = None
    department_id: Optional[UUID] = None
    recipient_id: Optional[UUID] = None
    recipient_name: Optional[str] = None


class RouteEntryOut(BaseModel):
    id: UUID
    from_user_id: Optional[UUID] = None
    to_user_id: Optional[UUID] = None
    from_user_name: Optional[str] = None
    to_user_name: Optional[str] = None
    from_user_info: Optional[PersonInfo] = None
    to_user_info: Optional[PersonInfo] = None
    action: RouteAction
    remarks: Optional[str] = None
    is_current: bool
    created_at: datetime
    model_config = {"from_attributes": True}


class AttachmentOut(BaseModel):
    id: UUID
    original_name: str
    stored_name: str
    file_size: Optional[int] = None
    mime_type: Optional[str] = None
    uploaded_by: UUID
    created_at: datetime
    model_config = {"from_attributes": True}


class NotesheetOut(BaseModel):
    id: UUID
    content: str
    version: int
    is_locked: bool
    model_config = {"from_attributes": True}


class FileOut(BaseModel):
    id: UUID
    ref_number: str
    subject: str
    category: str
    status: FileStatus
    priority: FilePriority
    is_confidential: bool
    due_date: Optional[datetime] = None
    created_by: UUID
    department_id: Optional[UUID] = None
    current_holder_id: Optional[UUID] = None
    recipient_id: Optional[UUID] = None
    recipient_name: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    is_released: bool = False
    released_at: Optional[datetime] = None
    released_by_info: Optional[PersonInfo] = None
    creator_info: Optional[PersonInfo] = None
    current_holder_info: Optional[PersonInfo] = None
    recipient_info: Optional[PersonInfo] = None
    notesheet: Optional[NotesheetOut] = None
    route_entries: List[RouteEntryOut] = []
    attachments: List[AttachmentOut] = []
    signatures: List[SignatureOut] = []
    model_config = {"from_attributes": True}


class NotesheetSave(BaseModel):
    content: str


class HolderNotesheetOut(BaseModel):
    """A single holder's OWN Notesheet for a file — distinct from
    NotesheetOut (the creator's single, shared document). One row exists per
    (file, user); `user_info` identifies whose contribution this is, for the
    read-only history list. `user_id` is never accepted from a client on the
    write side (see HolderNotesheetUpdate) — it only ever appears here, on
    reads, derived server-side."""
    id: UUID
    file_id: UUID
    user_id: UUID
    content: str
    created_at: datetime
    updated_at: datetime
    user_info: Optional[PersonInfo] = None
    model_config = {"from_attributes": True}


class HolderNotesheetUpdate(BaseModel):
    """Deliberately content-only — file_id comes from the URL path and
    user_id is always the authenticated caller; neither can be supplied by
    the client, so there is no way to target another user's row."""
    content: str


class RouteAction_(BaseModel):
    action: RouteAction
    to_user_id: Optional[UUID] = None
    remarks: Optional[str] = None


class DispatchCreate(BaseModel):
    mode: DispatchMode = DispatchMode.internal
    recipient: str = Field(..., min_length=2)
    address: Optional[str] = None
    tracking_ref: Optional[str] = None
    remarks: Optional[str] = None


class DispatchOut(BaseModel):
    id: UUID
    file_id: UUID
    dispatch_no: str
    mode: DispatchMode
    recipient: str
    address: Optional[str] = None
    dispatched_by: UUID
    dispatched_at: Optional[datetime] = None
    tracking_ref: Optional[str] = None
    remarks: Optional[str] = None
    model_config = {"from_attributes": True}
