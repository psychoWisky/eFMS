"""Project management + PI project-profile assignment — Super-Admin-only.

A project profile is created here as an ordinary `users` row (see
User.origin_user_id/project_id in app/models/user.py) with NO independent
credentials (hashed_password stays NULL) — every existing eFMS
authorization/ownership rule in efms_files.py/docket.py applies to it
completely unchanged, because to that code it is indistinguishable from any
other user. It is reachable only via POST /auth/switch-profile.

Reassignment and project completion never delete or mutate a profile's
identity/history — see _create_project_profile and complete_project/
reassign_project below: an outgoing profile is only ever deactivated
(is_active=False), never removed, so every file/notesheet/attachment/route
entry it ever touched remains exactly as valid as before.
"""
from datetime import date
from decimal import Decimal
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, update, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.base import get_db
from app.core.dependencies import require_roles
from app.models.user import User, UserRole, RefreshToken, SystemRole
from app.models.project import Project, ProjectStatus

router = APIRouter(prefix="/projects", tags=["Projects"])
_super = require_roles(SystemRole.SUPER_ADMIN)


# ── Schemas ───────────────────────────────────────────────────────────────────

class ProjectCreate(BaseModel):
    name: str
    total_funding: Optional[Decimal] = None
    funding_agency: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None


class ProjectOut(BaseModel):
    id: UUID
    project_number: str
    name: str
    total_funding: Optional[Decimal] = None
    funding_agency: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    status: str
    current_profile_id: Optional[UUID] = None
    current_profile_name: Optional[str] = None
    model_config = {"from_attributes": True}


class AssignRequest(BaseModel):
    user_id: UUID


class ReassignRequest(BaseModel):
    user_id: UUID


def _project_out(p: Project, current_profile_name: Optional[str] = None) -> ProjectOut:
    return ProjectOut(
        id=p.id, project_number=p.project_number, name=p.name,
        total_funding=p.total_funding, funding_agency=p.funding_agency,
        start_date=p.start_date, end_date=p.end_date, status=p.status,
        current_profile_id=p.current_profile_id,
        current_profile_name=current_profile_name,
    )


async def _generate_project_number(db: AsyncSession) -> str:
    """Auto-generated, globally unique, never admin-typed. Backed by the
    dedicated Postgres sequence `project_number_seq` (see migration 0014)
    rather than a count()+1 read — nextval() is atomic at the database
    level, so two concurrent POST /projects requests can never be handed
    the same number (the previous count()+1 approach could race and raise
    an unhandled unique-constraint IntegrityError). External format (a
    plain incrementing integer string, e.g. "74") is unchanged."""
    result = await db.execute(text("SELECT nextval('project_number_seq')"))
    return str(result.scalar_one())


async def _revoke_profile_sessions(db: AsyncSession, profile_id: UUID) -> None:
    """Reuses the exact bulk-revoke pattern auth.py's password-reset flow
    already uses — proactive defense-in-depth on top of the is_active check
    /auth/refresh already performs, so a completed/reassigned-away profile's
    outstanding refresh token can't mint one more access token even before
    its short-lived access token naturally expires."""
    await db.execute(
        update(RefreshToken).where(RefreshToken.user_id == profile_id, RefreshToken.revoked == False).values(revoked=True)
    )


def _build_profile_email(origin: User, project: Project) -> str:
    """Deterministic, unique, and NEVER used for login (the profile has no
    password) — purely to satisfy users.email's NOT NULL/unique constraint."""
    local, _, domain = origin.email.partition("@")
    return f"{local}+pi{project.project_number}@{domain}"


async def _create_project_profile(db: AsyncSession, origin: User, project: Project) -> User:
    """One new `users` row per (person, project) assignment — see the
    module docstring. Display name is auto-generated ("User A" + "PI74"),
    never independently editable; role/department/designation/establishment
    are a one-time snapshot of the origin user's current values, per the
    confirmed decision that these are not project-specific fields."""
    profile = User(
        email=_build_profile_email(origin, project),
        hashed_password=None,
        is_active=True,
        kyc_completed=True,
        must_change_password=False,
        first_name=origin.full_name,
        last_name=f"PI{project.project_number}",
        mobile=origin.mobile,
        designation=origin.designation,
        establishment_id=origin.establishment_id,
        department_id=origin.department_id,
        active_role=origin.active_role,
        can_sign=False,
        origin_user_id=origin.id,
        project_id=project.id,
    )
    db.add(profile)
    await db.flush()
    if origin.active_role:
        db.add(UserRole(user_id=profile.id, role=origin.active_role))
    return profile


def _assert_assignable(origin: Optional[User]) -> None:
    if not origin or origin.is_project_profile:
        raise HTTPException(400, "Recipient must be an existing original eFMS user, not a project profile.")
    if not origin.is_active:
        raise HTTPException(400, "Cannot assign an inactive user to a project.")
    if origin.active_role == SystemRole.SUPER_ADMIN:
        raise HTTPException(400, "A Super Admin cannot be assigned a project profile.")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("", response_model=ProjectOut, status_code=201)
async def create_project(body: ProjectCreate, db: AsyncSession = Depends(get_db), user: User = Depends(_super)):
    number = await _generate_project_number(db)
    p = Project(
        project_number=number, name=body.name, total_funding=body.total_funding,
        funding_agency=body.funding_agency, start_date=body.start_date, end_date=body.end_date,
        created_by=user.id,
    )
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return _project_out(p)


@router.get("", response_model=list[ProjectOut])
async def list_projects(db: AsyncSession = Depends(get_db), _: User = Depends(_super)):
    result = await db.execute(
        select(Project).options(selectinload(Project.current_profile)).order_by(Project.created_at.desc())
    )
    return [_project_out(p, p.current_profile.full_name if p.current_profile else None) for p in result.scalars().all()]


@router.post("/{project_id}/assign", response_model=ProjectOut)
async def assign_project(
    project_id: UUID, body: AssignRequest,
    db: AsyncSession = Depends(get_db), user: User = Depends(_super),
):
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found.")
    if project.status != ProjectStatus.active:
        raise HTTPException(400, "Only an active project can be assigned.")
    if project.current_profile_id:
        raise HTTPException(400, "This project already has an assigned profile. Use reassign instead.")

    origin = await db.get(User, body.user_id)
    _assert_assignable(origin)

    profile = await _create_project_profile(db, origin, project)
    project.current_profile_id = profile.id
    await db.commit()
    await db.refresh(project)
    return _project_out(project, profile.full_name)


@router.post("/{project_id}/reassign", response_model=ProjectOut)
async def reassign_project(
    project_id: UUID, body: ReassignRequest,
    db: AsyncSession = Depends(get_db), user: User = Depends(_super),
):
    """Never mutates the outgoing profile's identity — it is deactivated
    (kept forever, so every file/route entry/notesheet/attachment it ever
    touched stays intact and correctly attributed to it historically) and a
    brand-new profile row is created for the new person. The Project row
    itself (number/name/funding) is untouched."""
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found.")
    if not project.current_profile_id:
        raise HTTPException(400, "This project has no current assignment to reassign. Use assign instead.")

    origin = await db.get(User, body.user_id)
    _assert_assignable(origin)

    old_profile = await db.get(User, project.current_profile_id)
    if old_profile:
        old_profile.is_active = False
        await _revoke_profile_sessions(db, old_profile.id)

    new_profile = await _create_project_profile(db, origin, project)
    project.current_profile_id = new_profile.id
    await db.commit()
    await db.refresh(project)
    return _project_out(project, new_profile.full_name)


@router.patch("/{project_id}/complete", response_model=ProjectOut)
async def complete_project(project_id: UUID, db: AsyncSession = Depends(get_db), user: User = Depends(_super)):
    """Deactivates the current profile (cannot switch into it, cannot be
    selected as a recipient, cannot forward/receive) without touching the
    person-deactivation metadata columns (deactivation_reason_type etc.) —
    those stay reserved for a real person leaving, per the confirmed
    decision. All historical files/notesheets/attachments/tracking remain
    fully visible under the existing, unmodified authorization rules."""
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found.")
    project.status = ProjectStatus.completed
    profile = None
    if project.current_profile_id:
        profile = await db.get(User, project.current_profile_id)
        if profile:
            profile.is_active = False
        await _revoke_profile_sessions(db, project.current_profile_id)
    await db.commit()
    await db.refresh(project)
    return _project_out(project, profile.full_name if profile else None)


@router.patch("/{project_id}/reactivate", response_model=ProjectOut)
async def reactivate_project(project_id: UUID, db: AsyncSession = Depends(get_db), user: User = Depends(_super)):
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found.")
    project.status = ProjectStatus.active
    profile = None
    if project.current_profile_id:
        profile = await db.get(User, project.current_profile_id)
        if profile:
            profile.is_active = True
    await db.commit()
    await db.refresh(project)
    return _project_out(project, profile.full_name if profile else None)
