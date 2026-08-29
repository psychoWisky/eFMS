"""Project-specific user profiles (PI profiles).

A Project has at most one CURRENT profile (`current_profile_id`) — the
`users` row (see User.origin_user_id/project_id in app/models/user.py)
representing whichever person is presently assigned as its PI. Reassigning
a project to a different person never mutates or deletes that row; it gets
deactivated (is_active=False) and kept forever for historical FK integrity,
and a brand-new profile row is created and pointed at instead — see
app/api/v1/endpoints/projects.py.

Deliberately has NO department field and no department-based assignment
validation (explicit product decision — may be revisited later if AVFU
requires it)."""
import enum
from sqlalchemy import Column, String, Numeric, Date, Enum, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from app.db.base import Base, UUIDMixin, TimestampMixin


class ProjectStatus(str, enum.Enum):
    active = "active"
    completed = "completed"


class Project(Base, UUIDMixin, TimestampMixin):
    __tablename__ = "projects"

    project_number = Column(String(50), unique=True, nullable=False)  # auto-generated, e.g. "74"
    name           = Column(String(300), nullable=False)
    total_funding  = Column(Numeric(14, 2), nullable=True)
    funding_agency = Column(String(300), nullable=True)
    start_date     = Column(Date, nullable=True)
    end_date       = Column(Date, nullable=True)
    status         = Column(Enum(ProjectStatus, values_callable=lambda obj: [e.value for e in obj], name="project_status_enum"), default=ProjectStatus.active, nullable=False)

    # The users.id row currently representing this project's PI — see
    # app/models/user.py's User.project_id (the reverse pointer, set on the
    # profile row itself). Nullable only until first assignment; never
    # cleared afterward, only repointed on reassignment.
    current_profile_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    created_by          = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)

    current_profile = relationship("User", foreign_keys=[current_profile_id])
    creator         = relationship("User", foreign_keys=[created_by])
