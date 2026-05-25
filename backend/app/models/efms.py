"""eFMS models: files, notesheets, routing chain, attachments, dispatch."""
import enum
from sqlalchemy import (
    Column, String, Integer, Boolean, ForeignKey, Text,
    Enum as PgEnum, Index, DateTime,
)
from sqlalchemy.orm import relationship
from sqlalchemy.dialects.postgresql import JSONB, UUID
from app.db.base import Base, UUIDMixin, TimestampMixin


# ── Enums ─────────────────────────────────────────────────────────────────────

class FileStatus(str, enum.Enum):
    draft        = "draft"
    pending      = "pending"
    under_review = "under_review"
    approved     = "approved"
    rejected     = "rejected"
    dispatched   = "dispatched"
    archived     = "archived"
    locked       = "locked"

class FilePriority(str, enum.Enum):
    normal = "normal"
    urgent = "urgent"
    secret = "secret"

class RouteAction(str, enum.Enum):
    forward  = "forward"
    approve  = "approve"
    reject   = "reject"
    return_  = "return"
    dispatch = "dispatch"

class DispatchMode(str, enum.Enum):
    internal = "internal"
    postal   = "postal"
    email    = "email"
    courier  = "courier"


# ── File ──────────────────────────────────────────────────────────────────────

class EfmsFile(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "efms_files"

    ref_number    = Column(String(60), unique=True, nullable=False)  # AAU/AGR/2026/001
    subject       = Column(String(500), nullable=False)
    category      = Column(String(80), default="general")
    status        = Column(PgEnum(FileStatus, name="file_status_enum"), default=FileStatus.draft)
    priority      = Column(PgEnum(FilePriority, name="file_priority_enum"), default=FilePriority.normal)
    due_date      = Column(DateTime(timezone=True))
    is_confidential = Column(Boolean, default=False)

    created_by    = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    department_id = Column(UUID(as_uuid=True), ForeignKey("departments.id"), nullable=True)
    current_holder_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    recipient_id  = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    recipient_name = Column(String(200), nullable=True)

    creator       = relationship("User", foreign_keys=[created_by])
    current_holder = relationship("User", foreign_keys=[current_holder_id])
    recipient     = relationship("User", foreign_keys=[recipient_id])
    department    = relationship("Department")
    notesheet     = relationship("Notesheet", back_populates="file", uselist=False, cascade="all, delete-orphan")
    route_entries = relationship("RouteEntry", back_populates="file", cascade="all, delete-orphan", order_by="RouteEntry.created_at")
    attachments   = relationship("FileAttachment", back_populates="file", cascade="all, delete-orphan")
    dispatch      = relationship("DispatchRecord", back_populates="file", uselist=False)

    __table_args__ = (
        Index("ix_efms_file_status", "status"),
        Index("ix_efms_file_created_by", "created_by"),
        Index("ix_efms_file_holder", "current_holder_id"),
    )


# ── Notesheet ─────────────────────────────────────────────────────────────────

class Notesheet(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "notesheets"

    file_id       = Column(UUID(as_uuid=True), ForeignKey("efms_files.id"), unique=True, nullable=False)
    content       = Column(Text, default="")          # HTML content from rich editor
    version       = Column(Integer, default=1)
    last_saved_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    is_locked     = Column(Boolean, default=False)

    file          = relationship("EfmsFile", back_populates="notesheet")
    saver         = relationship("User")
    history       = relationship("NotesheetVersion", back_populates="notesheet", cascade="all, delete-orphan")


class NotesheetVersion(Base, UUIDMixin, TimestampMixin):
    """Immutable version snapshots saved on each forward/approve action."""
    __tablename__ = "notesheet_versions"

    notesheet_id  = Column(UUID(as_uuid=True), ForeignKey("notesheets.id"), nullable=False)
    version       = Column(Integer, nullable=False)
    content       = Column(Text, nullable=False)
    saved_by      = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)

    notesheet     = relationship("Notesheet", back_populates="history")
    author        = relationship("User")

    __table_args__ = (
        Index("ix_ns_version_notesheet", "notesheet_id"),
    )


# ── Routing ───────────────────────────────────────────────────────────────────

class RouteEntry(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "route_entries"

    file_id       = Column(UUID(as_uuid=True), ForeignKey("efms_files.id"), nullable=False)
    from_user_id  = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    to_user_id    = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    action        = Column(PgEnum(RouteAction, name="route_action_enum"), nullable=False)
    remarks       = Column(Text)
    is_current    = Column(Boolean, default=True)

    file          = relationship("EfmsFile", back_populates="route_entries")
    from_user     = relationship("User", foreign_keys=[from_user_id])
    to_user       = relationship("User", foreign_keys=[to_user_id])

    __table_args__ = (
        Index("ix_route_file", "file_id"),
        Index("ix_route_to_user", "to_user_id"),
    )


# ── Attachments ───────────────────────────────────────────────────────────────

class FileAttachment(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "file_attachments"

    file_id       = Column(UUID(as_uuid=True), ForeignKey("efms_files.id"), nullable=False)
    original_name = Column(String(255), nullable=False)
    stored_name   = Column(String(255), nullable=False)  # UUID-based stored filename
    file_size     = Column(Integer)                       # bytes
    mime_type     = Column(String(100))
    uploaded_by   = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)

    file          = relationship("EfmsFile", back_populates="attachments")
    uploader      = relationship("User")

    __table_args__ = (
        Index("ix_attachment_file", "file_id"),
    )


# ── Dispatch ──────────────────────────────────────────────────────────────────

class DispatchRecord(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "dispatch_records"

    file_id       = Column(UUID(as_uuid=True), ForeignKey("efms_files.id"), unique=True, nullable=False)
    dispatch_no   = Column(String(60), unique=True, nullable=False)
    mode          = Column(PgEnum(DispatchMode, name="dispatch_mode_enum"), default=DispatchMode.internal)
    recipient     = Column(String(300))
    address       = Column(Text)
    dispatched_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    dispatched_at = Column(DateTime(timezone=True))
    tracking_ref  = Column(String(100))
    remarks       = Column(Text)

    file          = relationship("EfmsFile", back_populates="dispatch")
    officer       = relationship("User")

    __table_args__ = (
        Index("ix_dispatch_file", "file_id"),
    )
