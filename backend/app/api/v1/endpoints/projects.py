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
from app.models.user import User, RefreshToken, SystemRole
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
    # Optional: assign a PI (create the project profile) in the same step.
    # Omit it to keep the existing two-step flow — create now, Assign later.
    assign_user_id: Optional[UUID] = None


class ProjectUpdate(BaseModel):
    """Super-admin edit of a project's own details. Only fields actually
    sent are changed; sending null clears an optional field. The project
    number (auto-generated), status (Complete / Reactivate) and PI (Assign /
    Reassign / Edit PI) have their own actions and are not edited here."""
    name: Optional[str] = None
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


class ProfileOut(BaseModel):
    """The project's current PI profile, for pre-filling the super-admin
    Edit-PI form. Read-only view."""
    id: UUID
    first_name: Optional[str] = None
    middle_name: Optional[str] = None
    last_name: Optional[str] = None
    full_name: str
    designation: Optional[str] = None
    mobile: Optional[str] = None
    department_id: Optional[UUID] = None
    establishment_id: Optional[UUID] = None
    active_role: Optional[str] = None
    can_sign: bool = False
    is_active: bool = True


class ProfileEditRequest(BaseModel):
    """Super-admin edit of the project's CURRENT PI profile. Every profile
    field a super admin might reasonably change is here; identity links
    (origin_user_id, project_id) are never editable — those define WHICH
    (person, project) this profile is and are set only by assign/reassign."""
    first_name: Optional[str] = None
    middle_name: Optional[str] = None
    last_name: Optional[str] = None
    designation: Optional[str] = None
    mobile: Optional[str] = None
    department_id: Optional[UUID] = None
    establishment_id: Optional[UUID] = None
    role: Optional[str] = None
    can_sign: Optional[bool] = None


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


async def _build_profile_email(db: AsyncSession, origin: User, project: Project) -> str:
    """A synthetic, never-used-for-login address (the profile has no
    password) that only has to satisfy users.email's NOT NULL + UNIQUE
    constraint. The natural form is "<local>+pi<N>@<domain>", but that same
    (person, project) pair can legitimately recur — reassign A -> B -> A
    leaves A's first, now-deactivated profile row still holding that exact
    address — so when it's taken we suffix a counter ("+pi3-2", "+pi3-3", …)
    until we find a free one rather than letting the INSERT 500 on a unique
    violation."""
    local, _, domain = origin.email.partition("@")
    base = f"{local}+pi{project.project_number}"
    candidate = f"{base}@{domain}"
    n = 1
    while await db.scalar(select(User.id).where(User.email == candidate)) is not None:
        n += 1
        candidate = f"{base}-{n}@{domain}"
    return candidate


async def _create_project_profile(db: AsyncSession, origin: User, project: Project) -> User:
    """One new `users` row per (person, project) assignment — see the
    module docstring. Display name is auto-generated ("User A" + "PI74"),
    never independently editable; role/department/designation/establishment
    are a one-time snapshot of the origin user's current values, per the
    confirmed decision that these are not project-specific fields.

    Deliberately does NOT create any user_roles row for the profile (and
    does not support Switch Role on it): a PI profile is a project
    identity, not a person — the origin person already holds the role(s).
    An earlier version of this copied the origin's full role set into the
    profile's own user_roles so it could switch roles too, but that made a
    profile count as an independent "holder" of every role the origin had
    AT ASSIGNMENT TIME — permanently, even after the origin's real role
    later changed — which inflated Role Management's user_count for roles
    no real person actually holds. active_role is still set (JWT/
    authorization elsewhere key off it), it just never changes for a
    profile."""
    profile = User(
        email=await _build_profile_email(db, origin, project),
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
    await db.flush()

    # Optional one-step assignment — same validation and profile creation as
    # POST /projects/{id}/assign. If assign_user_id is omitted the project is
    # simply created unassigned and the Assign button handles it later.
    profile_name: Optional[str] = None
    if body.assign_user_id is not None:
        origin = await db.scalar(select(User).where(User.id == body.assign_user_id))
        _assert_assignable(origin)
        profile = await _create_project_profile(db, origin, p)
        p.current_profile_id = profile.id
        profile_name = profile.full_name

    await db.commit()
    await db.refresh(p)
    return _project_out(p, profile_name)


@router.get("", response_model=list[ProjectOut])
async def list_projects(db: AsyncSession = Depends(get_db), _: User = Depends(_super)):
    result = await db.execute(
        select(Project).options(selectinload(Project.current_profile)).order_by(Project.created_at.desc())
    )
    return [_project_out(p, p.current_profile.full_name if p.current_profile else None) for p in result.scalars().all()]


@router.patch("/{project_id}", response_model=ProjectOut)
async def update_project(
    project_id: UUID, body: ProjectUpdate,
    db: AsyncSession = Depends(get_db), _: User = Depends(_super),
):
    """Edit a project's details (name, funding agency, total funding, start
    and end date) — active or completed. Never touches the PI profile: its
    display name is "<person> PI<project number>", which doesn't change."""
    project = await db.scalar(
        select(Project).options(selectinload(Project.current_profile)).where(Project.id == project_id)
    )
    if not project:
        raise HTTPException(404, "Project not found.")

    sent = body.model_fields_set
    if "name" in sent:
        name = (body.name or "").strip()
        if not name:
            raise HTTPException(400, "Project name cannot be empty.")
        project.name = name
    if "funding_agency" in sent:
        project.funding_agency = (body.funding_agency or "").strip() or None
    if "total_funding" in sent:
        if body.total_funding is not None and body.total_funding < 0:
            raise HTTPException(400, "Total funding cannot be negative.")
        project.total_funding = body.total_funding
    if "start_date" in sent:
        project.start_date = body.start_date
    if "end_date" in sent:
        project.end_date = body.end_date
    if project.start_date and project.end_date and project.end_date < project.start_date:
        raise HTTPException(400, "End date cannot be before the start date.")

    await db.commit()
    return _project_out(project, project.current_profile.full_name if project.current_profile else None)


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

    origin = await db.scalar(select(User).where(User.id == body.user_id))
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
    brand-new profile row is created for the new person.

    Every file the OLD profile created, currently holds, or released is
    moved onto the NEW profile's own account (real ownership-field rewrite,
    same mechanism as per-role ownership transfer — see
    efms_files.reassign_file_ownership) — so it shows up in the new PI's
    own My Files / Docket / Released Files exactly as it did for the old
    one, with no separate "accept this forward" step needed. This closes
    a real gap: previously a reassigned project's files were untraceable
    from the new profile at all, only reachable via the old (now
    deactivated) one. The Project row itself (number/name/funding) is
    untouched."""
    from app.api.v1.endpoints.efms_files import reassign_file_ownership

    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found.")
    if not project.current_profile_id:
        raise HTTPException(400, "This project has no current assignment to reassign. Use assign instead.")

    origin = await db.scalar(select(User).where(User.id == body.user_id))
    _assert_assignable(origin)

    old_profile = await db.get(User, project.current_profile_id)

    new_profile = await _create_project_profile(db, origin, project)
    await db.flush()

    if old_profile:
        note = f"Project reassigned ({project.name}): {old_profile.full_name} → {new_profile.full_name}"
        await reassign_file_ownership(
            db, old_id=old_profile.id, new_id=new_profile.id, new_role=new_profile.active_role,
            actor_id=user.id, note=note, role_filter=None,
        )
        old_profile.is_active = False
        # Historical-access safety net, same pattern as ownership transfer:
        # anything not caught by the explicit file-reassignment above (e.g.
        # a future access-check path) still resolves through this chain.
        new_profile.account_predecessor_id = old_profile.id
        await _revoke_profile_sessions(db, old_profile.id)

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


@router.get("/{project_id}/profile", response_model=ProfileOut)
async def get_project_profile(
    project_id: UUID,
    db: AsyncSession = Depends(get_db), user: User = Depends(_super),
):
    """Current PI profile of a project — pre-fills the super-admin Edit-PI
    form. 404 if the project has no assignment yet."""
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found.")
    if not project.current_profile_id:
        raise HTTPException(404, "This project has no assigned PI profile.")
    p = await db.get(User, project.current_profile_id)
    if not p:
        raise HTTPException(404, "Assigned profile not found.")
    return ProfileOut(
        id=p.id, first_name=p.first_name, middle_name=p.middle_name, last_name=p.last_name,
        full_name=p.full_name, designation=p.designation, mobile=p.mobile,
        department_id=p.department_id, establishment_id=p.establishment_id,
        active_role=p.active_role, can_sign=p.can_sign, is_active=p.is_active,
    )


@router.patch("/{project_id}/profile", response_model=ProjectOut)
async def edit_project_profile(
    project_id: UUID, body: ProfileEditRequest,
    db: AsyncSession = Depends(get_db), user: User = Depends(_super),
):
    """Super-admin edit of the project's current PI profile — name,
    designation, mobile, department, establishment, role and can-sign. A PI
    profile is otherwise auto-generated and not editable anywhere else.
    Never touches origin_user_id / project_id (those define which
    person+project this profile is) and never creates a new row."""
    from app.api.v1.endpoints.auth import _validate_assignable_role, _set_single_role

    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found.")
    if not project.current_profile_id:
        raise HTTPException(400, "This project has no assigned PI profile to edit.")

    profile = await db.get(User, project.current_profile_id)
    if not profile:
        raise HTTPException(404, "Assigned profile not found.")

    if body.first_name is not None:
        fn = body.first_name.strip()
        if not fn:
            raise HTTPException(400, "First name cannot be empty.")
        profile.first_name = fn
    if body.middle_name is not None:
        profile.middle_name = body.middle_name.strip() or None
    if body.last_name is not None:
        profile.last_name = body.last_name.strip() or None
    if body.designation is not None:
        profile.designation = body.designation.strip() or None
    if body.mobile is not None:
        profile.mobile = body.mobile.strip() or None
    if body.department_id is not None:
        profile.department_id = body.department_id
    if body.establishment_id is not None:
        profile.establishment_id = body.establishment_id
    if body.can_sign is not None:
        profile.can_sign = body.can_sign
    if body.role is not None and body.role != profile.active_role:
        # Same catalog validation the admin user-edit path uses. A PI
        # profile can never be SUPER_ADMIN (it is a workflow identity, not
        # a person) — reject that explicitly rather than relying on the
        # role simply not existing in the catalog.
        if body.role == SystemRole.SUPER_ADMIN.value:
            raise HTTPException(400, "A project profile cannot hold the Super Admin role.")
        role = await _validate_assignable_role(db, body.role)
        await _set_single_role(db, profile, role)

    await db.commit()
    await db.refresh(project)
    return _project_out(project, profile.full_name)


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
