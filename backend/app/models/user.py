from sqlalchemy import Column, String, Boolean, Enum, ForeignKey, Date, DateTime, UniqueConstraint
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
from sqlalchemy.dialects.postgresql import UUID
import enum
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


# Single source of truth for "which roles may participate in eFMS administrative
# workflows" — user creation/edit and every recipient-picker endpoint validate
# against this set rather than each maintaining their own role list. HOD and
# FACULTY are included deliberately: they may legitimately route files once
# AMS/eFMS user sync exists. Student/Academic Cell/DPGS/Result Branch are
# academic-only roles with no administrative function in eFMS and are excluded.
# This is independent of where a user record originates (local DB today,
# a synchronized/shared store later) — only active_role is ever consulted.
EFMS_ASSIGNABLE_ROLES = frozenset({
    SystemRole.SUPER_ADMIN, SystemRole.ADMIN,
    SystemRole.EFMS_OFFICER, SystemRole.EFMS_ADMIN,
    SystemRole.REGISTRAR, SystemRole.DISPATCH_OFFICER,
    SystemRole.HOD, SystemRole.FACULTY,
})


class Gender(str, enum.Enum):
    MALE = "male"
    FEMALE = "female"
    OTHER = "other"


class User(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "users"

    email = Column(String(255), unique=True, nullable=False, index=True)
    hashed_password = Column(String(255), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    kyc_completed = Column(Boolean, default=False, nullable=False)
    must_change_password = Column(Boolean, default=False, nullable=False)
    google_id = Column(String(255), unique=True, nullable=True)

    # Profile
    first_name = Column(String(100), nullable=True)
    last_name = Column(String(100), nullable=True)
    date_of_birth = Column(Date, nullable=True)
    gender = Column(Enum(Gender, values_callable=lambda obj: [e.value for e in obj], name="gender_enum", create_constraint=False), nullable=True)
    mobile = Column(String(20), nullable=True)
    profile_photo_url = Column(String(500), nullable=True)

    # Official Details
    employee_code = Column(String(20), nullable=True, index=True)
    designation = Column(String(100), nullable=True)
    establishment_id = Column(UUID(as_uuid=True), ForeignKey("establishments.id"), nullable=True)
    department_id = Column(UUID(as_uuid=True), ForeignKey("departments.id"), nullable=True)

    # Active role context
    active_role = Column(Enum(SystemRole, values_callable=lambda obj: [e.value for e in obj], name="system_role", create_constraint=False), nullable=True)

    # Digital signature permission
    can_sign = Column(Boolean, default=False, nullable=False)

    # Relationships
    roles = relationship("UserRole", back_populates="user", cascade="all, delete-orphan")
    establishment = relationship("Establishment", back_populates="users", foreign_keys=[establishment_id])
    department = relationship("Department", back_populates="users", foreign_keys=[department_id])
    refresh_tokens = relationship("RefreshToken", back_populates="user", cascade="all, delete-orphan")
    audit_logs = relationship("AuditLog", back_populates="user")

    @property
    def full_name(self) -> str:
        parts = [self.first_name, self.last_name]
        return " ".join(p for p in parts if p)


class UserRole(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "user_roles"

    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role = Column(Enum(SystemRole, values_callable=lambda obj: [e.value for e in obj], name="system_role", create_constraint=False), nullable=False)

    user = relationship("User", back_populates="roles")


class RefreshToken(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "refresh_tokens"

    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token_hash = Column(String(64), unique=True, nullable=False, index=True)
    revoked = Column(Boolean, default=False)
    expires_at = Column(DateTime(timezone=True), nullable=False)

    user = relationship("User", back_populates="refresh_tokens")


class FavoriteRecipient(Base, UUIDMixin, TimestampMixin):
    """A user's personal recipient shortlist — created_at (via TimestampMixin)
    is kept for future "recently favorited" ordering even though no such
    ordering is needed today; no manual sort_order column, since favorites
    are always alphabetical within their group, matching every other
    recipient list in eFMS."""
    __tablename__ = "favorite_recipients"

    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    recipient_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    __table_args__ = (
        UniqueConstraint("user_id", "recipient_id", name="uq_favorite_recipient"),
    )
