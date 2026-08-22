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


class Gender(str, enum.Enum):
    MALE = "male"
    FEMALE = "female"
    OTHER = "other"


class DeactivationReasonType(str, enum.Enum):
    RETIRED = "retired"
    TRANSFERRED = "transferred"
    RESIGNED = "resigned"
    LEFT_ORGANIZATION = "left_organization"
    SUSPENDED = "suspended"
    OTHER = "other"


class Role(Base, UUIDMixin, TimestampMixin):
    """Manageable role catalog (Super Admin "Roles" section). This is a
    metadata/administration layer on top of the same role names User.
    active_role has always used — it does NOT replace or gate authorization.
    SUPER_ADMIN's global bypass is checked exclusively via
    User.is_super_admin (== SystemRole.SUPER_ADMIN), never via anything on
    this table, so creating/editing a Role row can never grant it.

    is_system=True is set on exactly one row: super_admin — the only role
    this application's privilege check is explicitly tied to (see
    User.is_super_admin). Every other role, including the 11 other
    development/test roles this app originally shipped with, is an
    ordinary role: renamable and (once unassigned) deletable like any role
    Super Admin creates through Role Management. Role names carry no
    inherent eFMS-workflow meaning — all non-SUPER_ADMIN roles are equal."""
    __tablename__ = "roles"

    name = Column(String(50), unique=True, nullable=False, index=True)
    description = Column(String(255), nullable=True)
    is_system = Column(Boolean, default=False, nullable=False)


class User(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "users"

    email = Column(String(255), unique=True, nullable=False, index=True)
    hashed_password = Column(String(255), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    kyc_completed = Column(Boolean, default=False, nullable=False)
    must_change_password = Column(Boolean, default=False, nullable=False)
    google_id = Column(String(255), unique=True, nullable=True)

    # Deactivation metadata — is_active above remains the single field the
    # auth layer checks; these only record why/when/by-whom for display and
    # audit purposes, and are left untouched on reactivation (is_active=True)
    # rather than cleared, so the last deactivation reason stays visible.
    deactivation_reason_type = Column(
        Enum(DeactivationReasonType, values_callable=lambda obj: [e.value for e in obj], name="deactivation_reason_type_enum", create_constraint=False),
        nullable=True,
    )
    deactivation_remarks = Column(String(1000), nullable=True)
    deactivated_at = Column(DateTime(timezone=True), nullable=True)
    deactivated_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)

    # Profile
    first_name = Column(String(100), nullable=True)
    middle_name = Column(String(100), nullable=True)
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

    # Active role context — plain string, validated at the application layer
    # against the `roles` table (see Role above), not a Postgres enum
    # constraint. Was `Enum(SystemRole, ..., name="system_role")` before the
    # Role Management feature; widened to String so newly-created custom
    # roles (which can't be added to a fixed Postgres enum type without a
    # schema change per role) can be assigned like any pre-existing role.
    # The `== SystemRole.SUPER_ADMIN` privilege comparison still works
    # unchanged: SystemRole is a `str` subclass, so its members compare/hash
    # equal to plain strings.
    active_role = Column(String(50), nullable=True)

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
        parts = [self.first_name, self.middle_name, self.last_name]
        return " ".join(p for p in parts if p)

    @property
    def is_super_admin(self) -> bool:
        """SUPER_ADMIN is the only globally privileged role — the single
        source of truth for the system-wide admin bypass. No other role
        (including plain ADMIN) may satisfy this."""
        return self.active_role == SystemRole.SUPER_ADMIN


class UserRole(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "user_roles"

    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role = Column(String(50), nullable=False)

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
