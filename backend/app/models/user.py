from sqlalchemy import Column, String, Boolean, Enum, Text, ForeignKey, Date
from sqlalchemy.orm import relationship
from sqlalchemy.dialects.postgresql import UUID, ARRAY
import enum
import uuid
from app.db.base import Base, TimestampMixin, UUIDMixin


class SystemRole(str, enum.Enum):
    SUPER_ADMIN = "super_admin"
    ADMIN = "admin"
    # AMS roles
    HOD = "hod"
    FACULTY = "faculty"
    STUDENT = "student"
    ACADEMIC_CELL = "academic_cell"
    DPGS = "dpgs"
    RESULT_BRANCH = "result_branch"
    # eFMS roles
    EFMS_OFFICER = "efms_officer"
    EFMS_ADMIN = "efms_admin"
    REGISTRAR = "registrar"
    DISPATCH_OFFICER = "dispatch_officer"


class Gender(str, enum.Enum):
    MALE = "male"
    FEMALE = "female"
    OTHER = "other"


class User(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "users"

    email = Column(String(255), unique=True, nullable=False, index=True)
    hashed_password = Column(String(255), nullable=True)  # null for OAuth users
    is_active = Column(Boolean, default=True, nullable=False)
    is_verified = Column(Boolean, default=False, nullable=False)
    kyc_completed = Column(Boolean, default=False, nullable=False)
    is_approved = Column(Boolean, default=False, nullable=False)
    is_pending_approval = Column(Boolean, default=True, nullable=False)
    google_id = Column(String(255), unique=True, nullable=True)

    # Profile
    first_name = Column(String(100), nullable=True)
    middle_name = Column(String(100), nullable=True)
    last_name = Column(String(100), nullable=True)
    date_of_birth = Column(Date, nullable=True)
    gender = Column(Enum(Gender, values_callable=lambda obj: [e.value for e in obj], name="gender_enum", create_constraint=False), nullable=True)
    mobile = Column(String(20), nullable=True)
    alternate_mobile = Column(String(20), nullable=True)
    residential_address = Column(Text, nullable=True)
    profile_photo_url = Column(String(500), nullable=True)

    # Official Details
    employee_code = Column(String(11), unique=True, nullable=True, index=True)
    designation = Column(String(150), nullable=True)
    establishment_id = Column(UUID(as_uuid=True), ForeignKey("establishments.id"), nullable=True)
    department_id = Column(UUID(as_uuid=True), ForeignKey("departments.id"), nullable=True)

    # Active role context
    active_role = Column(Enum(SystemRole, values_callable=lambda obj: [e.value for e in obj], name="system_role", create_constraint=False), nullable=True)

    # Relationships
    roles = relationship("UserRole", back_populates="user", cascade="all, delete-orphan")
    establishment = relationship("Establishment", back_populates="users", foreign_keys=[establishment_id])
    department = relationship("Department", back_populates="users", foreign_keys=[department_id])
    refresh_tokens = relationship("RefreshToken", back_populates="user", cascade="all, delete-orphan")
    audit_logs = relationship("AuditLog", back_populates="user")

    @property
    def full_name(self) -> str:
        parts = [self.first_name, self.middle_name, self.last_name]
        return " ".join(p for p in parts if p)


class UserRole(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "user_roles"

    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role = Column(Enum(SystemRole, values_callable=lambda obj: [e.value for e in obj], name="system_role", create_constraint=False), nullable=False)
    department_id = Column(UUID(as_uuid=True), ForeignKey("departments.id"), nullable=True)
    establishment_id = Column(UUID(as_uuid=True), ForeignKey("establishments.id"), nullable=True)
    is_active = Column(Boolean, default=True)

    user = relationship("User", back_populates="roles")
    department = relationship("Department")
    establishment = relationship("Establishment")


class RefreshToken(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "refresh_tokens"

    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token_hash = Column(String(255), unique=True, nullable=False, index=True)
    is_revoked = Column(Boolean, default=False)
    expires_at = Column(String(50), nullable=False)
    device_info = Column(String(255), nullable=True)

    user = relationship("User", back_populates="refresh_tokens")
