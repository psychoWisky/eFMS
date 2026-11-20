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
    # 'pending' until the token's signature is added, then 'verified'
    status      = Column(String(20), nullable=False, default="pending")
    # 'dsc' = signed with the officer's DSC token; 'otp' = earlier signatures
    # (kept as they are, no longer created).
    method      = Column(String(10), nullable=False, default="dsc", server_default="otp")
    attachment_id = Column(UUID(as_uuid=True), ForeignKey("file_attachments.id", ondelete="SET NULL"), nullable=True)
    # The prepared PDF waiting for the token's signature (kept outside the
    # public uploads folder) and the state needed to finish it.
    prepared_name  = Column(String(80), nullable=True)
    digest_hex     = Column(String(64), nullable=True)
    reserved_start = Column(Integer, nullable=True)
    reserved_end   = Column(Integer, nullable=True)
    field_name     = Column(String(40), nullable=True)
    # Certificate recorded when the signature was added.
    cert_cn          = Column(String(255), nullable=True)
    cert_serial      = Column(String(80), nullable=True)
    cert_issuer      = Column(String(500), nullable=True)
    cert_not_after   = Column(DateTime(timezone=True), nullable=True)
    cert_fingerprint = Column(String(64), nullable=True)
    signed_at   = Column(DateTime(timezone=True), server_default=func.now())
    verified_at = Column(DateTime(timezone=True), nullable=True)
    created_at  = Column(DateTime(timezone=True), server_default=func.now())
    updated_at  = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    user = relationship("User")
    file = relationship("EfmsFile")
