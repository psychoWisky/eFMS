from sqlalchemy import Column, String, Text, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.dialects.postgresql import UUID, JSONB
from app.db.base import Base, TimestampMixin, UUIDMixin


class AuditLog(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "audit_logs"

    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    action = Column(String(100), nullable=False, index=True)
    resource_type = Column(String(100), nullable=False, index=True)
    resource_id = Column(String(255), nullable=True)
    ip_address = Column(String(45), nullable=True)
    user_agent = Column(String(500), nullable=True)
    details = Column(JSONB, nullable=True)
    system = Column(String(20), nullable=False, default="AMS")  # AMS or eFMS

    user = relationship("User", back_populates="audit_logs")
