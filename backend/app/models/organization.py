from sqlalchemy import Column, String, Boolean, Text, ForeignKey, DateTime, func
from sqlalchemy.orm import relationship
from sqlalchemy.dialects.postgresql import UUID
from app.db.base import Base, UUIDMixin
import uuid as _uuid


class Establishment(Base, UUIDMixin):
    __tablename__ = "establishments"

    name        = Column(String(255), nullable=False, unique=True)
    code        = Column(String(50), nullable=True)
    description = Column(Text, nullable=True)
    is_active   = Column(Boolean, default=True)
    created_at  = Column(DateTime(timezone=True), server_default=func.now())
    updated_at  = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    departments = relationship("Department", back_populates="establishment")
    users       = relationship("User", back_populates="establishment", foreign_keys="[User.establishment_id]")


class Department(Base, UUIDMixin):
    __tablename__ = "departments"

    name                  = Column(String(255), nullable=False)
    code                  = Column(String(50), nullable=True)
    establishment_id      = Column(UUID(as_uuid=True), ForeignKey("establishments.id"), nullable=True)
    is_active             = Column(Boolean, default=True)
    head_of_department_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_at            = Column(DateTime(timezone=True), server_default=func.now())
    updated_at            = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    establishment = relationship("Establishment", back_populates="departments")
    users         = relationship("User", back_populates="department", foreign_keys="[User.department_id]")
    hod           = relationship("User", foreign_keys=[head_of_department_id])
