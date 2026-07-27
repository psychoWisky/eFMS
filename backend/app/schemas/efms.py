"""Pydantic v2 schemas for eFMS resources."""
from __future__ import annotations
from datetime import datetime
from typing import Optional, List
from uuid import UUID
from pydantic import BaseModel, Field

from app.models.efms import FileStatus, FilePriority, RouteAction, DispatchMode


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


class RouteEntryOut(BaseModel):
    id: UUID
    from_user_id: Optional[UUID] = None
    to_user_id: Optional[UUID] = None
    from_user_name: Optional[str] = None
    to_user_name: Optional[str] = None
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
    notesheet: Optional[NotesheetOut] = None
    route_entries: List[RouteEntryOut] = []
    attachments: List[AttachmentOut] = []
    signatures: List[SignatureOut] = []
    model_config = {"from_attributes": True}


class NotesheetSave(BaseModel):
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
