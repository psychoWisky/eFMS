"""Super-admin managed lookup tables and notifications."""
import uuid
from sqlalchemy import Column, String, Boolean, Text, ForeignKey, DateTime, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from app.db.base import Base


class FileCategory(Base):
    __tablename__ = "file_categories"
    id          = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name        = Column(String(100), nullable=False, unique=True)
    description = Column(Text, nullable=True)
    is_active   = Column(Boolean, default=True)
    created_at  = Column(DateTime(timezone=True), server_default=func.now())


class FilePriority(Base):
    __tablename__ = "file_priorities"
    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name       = Column(String(50), nullable=False, unique=True)
    label      = Column(String(50), nullable=False)
    is_active  = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class FileRecipient(Base):
    __tablename__ = "file_recipients"
    id          = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name        = Column(String(200), nullable=False)
    designation = Column(String(150), nullable=True)
    email       = Column(String(255), nullable=True)
    user_id     = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    is_active   = Column(Boolean, default=True)
    created_at  = Column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User")


class Notification(Base):
    __tablename__ = "notifications"
    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id    = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    title      = Column(String(200), nullable=False)
    message    = Column(Text, nullable=True)
    type       = Column(String(50), default="info")
    file_id    = Column(UUID(as_uuid=True), ForeignKey("efms_files.id", ondelete="SET NULL"), nullable=True)
    is_read    = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User")
