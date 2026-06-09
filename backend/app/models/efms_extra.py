"""Extra eFMS models: OTP, Docket, FileRemark, FileSignature."""
import uuid
from sqlalchemy import Column, String, Boolean, Text, ForeignKey, DateTime, Float, Integer, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from app.db.base import Base


class OTP(Base):
    __tablename__ = "otps"
    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    target     = Column(String(255), nullable=False, index=True)  # email or mobile
    otp_type   = Column(String(20), default="email")              # email | mobile
    code       = Column(String(10), nullable=False)
    is_used    = Column(Boolean, default=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Docket(Base):
    __tablename__ = "dockets"
    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    file_id       = Column(UUID(as_uuid=True), ForeignKey("efms_files.id", ondelete="CASCADE"), nullable=False)
    department_id = Column(UUID(as_uuid=True), ForeignKey("departments.id"), nullable=True)
    is_released   = Column(Boolean, default=False)
    released_by   = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    released_at   = Column(DateTime(timezone=True), nullable=True)
    created_at    = Column(DateTime(timezone=True), server_default=func.now())

    file        = relationship("EfmsFile")
    department  = relationship("Department")
    releaser    = relationship("User")


class FileRemark(Base):
    __tablename__ = "file_remarks"
    id         = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    file_id    = Column(UUID(as_uuid=True), ForeignKey("efms_files.id", ondelete="CASCADE"), nullable=False)
    user_id    = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    remark     = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User")
    file = relationship("EfmsFile")


class FileSignature(Base):
    __tablename__ = "file_signatures"
    id          = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    file_id     = Column(UUID(as_uuid=True), ForeignKey("efms_files.id", ondelete="CASCADE"), nullable=False)
    user_id     = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    # Position as percentage of the PDF page (0–100)
    pos_x       = Column(Float, nullable=False)
    pos_y       = Column(Float, nullable=False)
    page_number = Column(Integer, nullable=False, default=1)
    # 'pending' until OTP verified, then 'verified'
    status      = Column(String(20), nullable=False, default="pending")
    signed_at   = Column(DateTime(timezone=True), server_default=func.now())
    verified_at = Column(DateTime(timezone=True), nullable=True)
    created_at  = Column(DateTime(timezone=True), server_default=func.now())
    updated_at  = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    user = relationship("User")
    file = relationship("EfmsFile")
