"""Super Admin delete guards and the one-holder-per-seat rule.

DELETE GUARDS
An item (user, role, department, establishment) can be deleted only while
nothing has been done with it. As soon as it is referenced by real work —
files, routing, notes, attachments, signatures, projects, … — deletion is
refused with the exact reasons, because removing it would orphan or rewrite
history. Everything that points at an item is found from the database's own
foreign keys (not a hand-kept list), so tables owned by the sibling
course/thesis application sharing this database — or any table added later —
block a delete too, even without a model here.

Each guard returns a list of human-readable reasons; an empty list means the
item is safe to delete. `blocked()` turns reasons into the HTTP error.

ROLE SEATS
A "seat" is (role, establishment, department): e.g. Registrar of Dept X in
Establishment Y. A seat can have only one holder. A role row with no
context of its own takes its holder's own establishment/department (see
workspace.role_context). A seat with neither an establishment nor a
department isn't a seat (organisation-wide roles) and super_admin is exempt.
"""
from __future__ import annotations

import re
from typing import Optional, Sequence
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import select, func, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.audit import AuditLog
from app.models.efms import EfmsFile, RouteEntry
from app.models.efms_extra import Docket
from app.models.organization import Department, Establishment
from app.models.user import Role, SystemRole, User, UserRole
from app.utils.workspace import role_context

_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
MAX_PEOPLE_LISTED = 8


def blocked(headline: str, reasons: Sequence[str], hint: Optional[str] = None) -> HTTPException:
    """409 whose detail is "headline", one "• reason" line per reason, and
    an optional closing hint. The UI shows the lines as written."""
    lines = [headline, *[f"• {r}" for r in reasons]]
    if hint:
        lines.append(hint)
    return HTTPException(status_code=409, detail="\n".join(lines))


def _n(n: int, noun: str) -> str:
    return f"{n} {noun}{'' if n == 1 else 's'}"


def _v(n: int, one: str, many: str) -> str:
    """Verb agreement: "1 file was", "3 files were"."""
    return one if n == 1 else many


def pretty_role(name: str) -> str:
    return " ".join(w.capitalize() for w in name.split("_"))


# ── Foreign-key discovery ────────────────────────────────────────────────────

_fk_cache: dict[str, list[tuple[str, str, str]]] = {}


async def _referrers(db: AsyncSession, target_table: str) -> list[tuple[str, str, str]]:
    """(table, column, delete_rule) for every single-column foreign key that
    points at `target_table`. delete_rule 'c' = rows are removed together
    with their parent. Cached: the schema only changes with a migration,
    which restarts the server."""
    if target_table not in _fk_cache:
        rows = (await db.execute(text(
            """
            SELECT cl.relname, a.attname, c.confdeltype::text
            FROM pg_constraint c
            JOIN pg_class cl ON cl.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
            WHERE c.contype = 'f' AND c.confrelid = CAST(:t AS regclass)
            ORDER BY cl.relname, a.attname
            """
        ), {"t": f"public.{target_table}"})).all()
        _fk_cache[target_table] = [(r[0], r[1], r[2]) for r in rows]
    return _fk_cache[target_table]


async def _count(db: AsyncSession, table: str, column: str, value: UUID) -> int:
    # table/column come from the catalog above, never from a request.
    if not (_IDENT.match(table) and _IDENT.match(column)):
        return 0
    return (await db.execute(
        text(f'SELECT count(*) FROM "{table}" WHERE "{column}" = :v'), {"v": value}
    )).scalar_one()


async def _scalar(db: AsyncSession, stmt) -> int:
    return (await db.execute(stmt)).scalar_one()


# ── What a user has done ─────────────────────────────────────────────────────

# (table, column) -> (verb phrase, noun). Rendered as "<verb> <n> <noun(s)>".
_USER_REFS: dict[tuple[str, str], tuple[str, str]] = {
    ("efms_files", "created_by"): ("created", "file"),
    ("efms_files", "current_holder_id"): ("currently holds", "file"),
    ("efms_files", "recipient_id"): ("is the chosen recipient of", "draft file"),
    ("notesheets", "last_saved_by"): ("saved the notesheet of", "file"),
    ("notesheet_versions", "saved_by"): ("saved", "notesheet version"),
    ("route_entries", "from_user_id"): ("forwarded or routed files in", "routing entry"),
    ("route_entries", "to_user_id"): ("received files through", "routing entry"),
    ("file_attachments", "uploaded_by"): ("uploaded", "attachment"),
    ("holder_notes", "user_id"): ("wrote", "holder note"),
    ("file_remarks", "user_id"): ("left", "file remark"),
    ("file_signatures", "user_id"): ("applied", "e-signature"),
    ("dispatch_records", "dispatched_by"): ("dispatched", "file"),
    ("dockets", "released_by"): ("released", "file"),
    ("file_recipients", "user_id"): ("is listed as", "file recipient"),
    ("projects", "created_by"): ("created", "project"),
    ("projects", "current_profile_id"): ("is the PI profile of", "project"),
    ("users", "deactivated_by"): ("deactivated", "other account"),
    ("users", "origin_user_id"): ("has", "project (PI) profile"),
    ("users", "account_predecessor_id"): ("is the predecessor of", "account"),
}


def _describe_user_ref(table: str, column: str, n: int) -> str:
    known = _USER_REFS.get((table, column))
    if known:
        verb, noun = known
        return f"{verb} {_n(n, noun)}"
    return f'is linked to {_n(n, "record")} in the "{table}" table ({column})'


async def user_activity(db: AsyncSession, user_id: UUID) -> list[str]:
    """What this user has done in the system, as short phrases ("created 3
    files", "wrote 2 holder notes", …). Empty = the user is idle and may be
    deleted. Their own sessions, role rows, favourites and notifications are
    not "activity" — they are removed together with the user."""
    reasons: list[str] = []
    for table, column, rule in await _referrers(db, "users"):
        if rule == "c":
            continue
        n = await _count(db, table, column, user_id)
        if n:
            reasons.append(_describe_user_ref(table, column, n))

    # Not enforced by a database foreign key, so checked explicitly.
    n = await _scalar(db, select(func.count()).select_from(AuditLog).where(AuditLog.user_id == user_id))
    if n:
        reasons.append(f"has {_n(n, 'audit log entry').replace('entrys', 'entries')}")
    n = await _scalar(db, select(func.count()).select_from(Department).where(Department.head_of_department_id == user_id))
    if n:
        reasons.append(f"is head of {_n(n, 'department')}")
    return reasons


async def _people_reasons(db: AsyncSession, people: list[User], where: str = "here") -> list[str]:
    """One line per assigned person: either their recorded activity (the
    "involved" case — permanent) or a plain "still assigned" line."""
    lines: list[str] = []
    for u in people[:MAX_PEOPLE_LISTED]:
        tag = f"{u.full_name} ({u.email})" + ("" if u.is_active else " [deactivated]")
        activity = await user_activity(db, u.id)
        if activity:
            lines.append(f"{tag} has already worked in eFMS — {'; '.join(activity)}. This history is permanent.")
        else:
            lines.append(f"{tag} is still assigned {where} — reassign or remove them first.")
    if len(people) > MAX_PEOPLE_LISTED:
        lines.append(f"…and {_n(len(people) - MAX_PEOPLE_LISTED, 'more user')} still assigned.")
    return lines


def _unique(users: Sequence[User]) -> list[User]:
    seen: set = set()
    out: list[User] = []
    for u in users:
        if u.id not in seen:
            seen.add(u.id)
            out.append(u)
    return out


async def _generic_refs(db: AsyncSession, target_table: str, target_id: UUID, handled: set[str]) -> list[str]:
    """Reasons for every other table that references the item (e.g. the
    sibling app's courses/theses) — anything not already explained."""
    out: list[str] = []
    for table, column, rule in await _referrers(db, target_table):
        # Rows removed together with the item (cascade) or just un-linked
        # (set null) don't stop a delete — only references that would be
        # orphaned do.
        if table in handled or rule in ("c", "n"):
            continue
        n = await _count(db, table, column, target_id)
        if n:
            out.append(f'{_n(n, "record")} in the "{table}" table ({column}) still {_v(n, "uses", "use")} it')
    return out


# ── Roles ────────────────────────────────────────────────────────────────────

async def role_blockers(db: AsyncSession, role_name: str) -> list[str]:
    reasons: list[str] = []

    holders = (await db.execute(
        select(User).join(UserRole, UserRole.user_id == User.id)
        .where(UserRole.role == role_name, User.origin_user_id.is_(None))
    )).scalars().all()
    legacy = (await db.execute(
        select(User).where(User.active_role == role_name, User.origin_user_id.is_(None))
    )).scalars().all()
    people = _unique([*holders, *legacy])
    if people:
        reasons.append(
            f"{_n(len(people), 'user')} {'is' if len(people) == 1 else 'are'} currently assigned to this role:"
        )
        reasons.extend(await _people_reasons(db, people, where="to this role"))

    created = await _scalar(db, select(func.count()).select_from(EfmsFile).where(EfmsFile.creator_role == role_name))
    held = await _scalar(db, select(func.count()).select_from(EfmsFile).where(EfmsFile.current_holder_role == role_name))
    addressed = await _scalar(db, select(func.count()).select_from(EfmsFile).where(EfmsFile.recipient_role == role_name))
    routed = await _scalar(db, select(func.count()).select_from(RouteEntry).where(
        (RouteEntry.from_role == role_name) | (RouteEntry.to_role == role_name)))
    used = []
    if created:
        used.append(f"{_n(created, 'file')} created while acting in this role")
    if held:
        used.append(f"{_n(held, 'file')} currently held in this role's workspace")
    if addressed:
        used.append(f"{_n(addressed, 'draft file')} addressed to this role")
    if routed:
        used.append(f"{_n(routed, 'routing entry').replace('entrys', 'entries')} recorded under this role")
    if used:
        reasons.append("This role has already been used for file work — " + "; ".join(used) + ". This history is permanent.")
    return reasons


# ── Departments and establishments ───────────────────────────────────────────

async def _org_people(db: AsyncSession, column: str, value: UUID) -> tuple[list[User], list[User]]:
    """(real people, project profiles) tied to a department/establishment,
    either through their own record or through a role-specific context."""
    col = getattr(User, column)
    ur_col = getattr(UserRole, column)
    direct = (await db.execute(select(User).where(col == value))).scalars().all()
    via_role = (await db.execute(
        select(User).join(UserRole, UserRole.user_id == User.id).where(ur_col == value)
    )).scalars().all()
    everyone = _unique([*direct, *via_role])
    return [u for u in everyone if u.origin_user_id is None], [u for u in everyone if u.origin_user_id is not None]


async def _profile_reason(profiles: list[User], what: str) -> list[str]:
    if not profiles:
        return []
    names = ", ".join(p.full_name for p in profiles[:MAX_PEOPLE_LISTED])
    return [f"{_n(len(profiles), 'project (PI) profile')} ({names}) carry this {what}. "
            "Change it from Projects → Edit PI, or keep it as project history."]


async def department_blockers(db: AsyncSession, dept_id: UUID) -> list[str]:
    people, profiles = await _org_people(db, "department_id", dept_id)
    reasons = await _people_reasons(db, people)
    reasons += await _profile_reason(profiles, "department")

    in_files = await _scalar(db, select(func.count()).select_from(EfmsFile).where(EfmsFile.department_id == dept_id))
    created = await _scalar(db, select(func.count()).select_from(EfmsFile).where(EfmsFile.creator_department_id == dept_id))
    held = await _scalar(db, select(func.count()).select_from(EfmsFile).where(EfmsFile.current_holder_department_id == dept_id))
    dockets = await _scalar(db, select(func.count()).select_from(Docket).where(Docket.department_id == dept_id))
    if in_files:
        reasons.append(f"{_n(in_files, 'file')} {_v(in_files, 'belongs', 'belong')} to this department.")
    if created:
        reasons.append(f"{_n(created, 'file')} {_v(created, 'was', 'were')} created by people acting in this department.")
    if held:
        reasons.append(f"{_n(held, 'file')} {_v(held, 'is', 'are')} currently held by people acting in this department.")
    if dockets:
        reasons.append(
            f"{_n(dockets, 'released docket entry').replace('entrys', 'entries')} "
            f"{_v(dockets, 'belongs', 'belong')} to this department."
        )

    reasons += await _generic_refs(db, "departments", dept_id, {"users", "user_roles", "efms_files", "dockets"})
    return reasons


async def establishment_blockers(db: AsyncSession, estb_id: UUID) -> list[str]:
    reasons: list[str] = []
    depts = (await db.execute(
        select(Department).where(Department.establishment_id == estb_id).order_by(Department.name)
    )).scalars().all()
    if depts:
        names = ", ".join(d.name for d in depts[:MAX_PEOPLE_LISTED])
        more = f" and {len(depts) - MAX_PEOPLE_LISTED} more" if len(depts) > MAX_PEOPLE_LISTED else ""
        reasons.append(f"It still has {_n(len(depts), 'department')}: {names}{more}. Delete those departments first.")

    people, profiles = await _org_people(db, "establishment_id", estb_id)
    reasons += await _people_reasons(db, people)
    reasons += await _profile_reason(profiles, "establishment")

    created = await _scalar(db, select(func.count()).select_from(EfmsFile).where(EfmsFile.creator_establishment_id == estb_id))
    held = await _scalar(db, select(func.count()).select_from(EfmsFile).where(EfmsFile.current_holder_establishment_id == estb_id))
    if created:
        reasons.append(f"{_n(created, 'file')} {_v(created, 'was', 'were')} created by people acting in this establishment.")
    if held:
        reasons.append(f"{_n(held, 'file')} {_v(held, 'is', 'are')} currently held by people acting in this establishment.")

    reasons += await _generic_refs(db, "establishments", estb_id, {"departments", "users", "user_roles", "efms_files"})
    return reasons


# ── One holder per seat ──────────────────────────────────────────────────────

Seat = tuple[str, Optional[UUID], Optional[UUID]]


async def multi_holder_roles(db: AsyncSession) -> set[str]:
    """Names of roles the Super Admin allowed several holders per seat."""
    rows = await db.execute(select(Role.name).where(Role.allow_multiple_holders == True))
    return set(rows.scalars().all())


def seat_of(user: User, ur: UserRole) -> Optional[Seat]:
    """The seat a role row occupies, or None when it isn't a seat."""
    if ur.role == SystemRole.SUPER_ADMIN:
        return None
    estb, dept = role_context(user, ur)
    if estb is None and dept is None:
        return None
    return (ur.role, estb, dept)


async def seats_of_user(db: AsyncSession, user: User) -> set[Seat]:
    """Fresh read of the seats `user` holds right now (their own current
    establishment/department included, for role rows without a context)."""
    rows = (await db.execute(select(UserRole).where(UserRole.user_id == user.id))).scalars().all()
    return {s for ur in rows if (s := seat_of(user, ur)) is not None}


async def _seat_label(db: AsyncSession, seat: Seat) -> str:
    role, estb_id, dept_id = seat
    parts = []
    if estb_id:
        e = await db.get(Establishment, estb_id)
        parts.append(f"establishment “{e.name if e else estb_id}”")
    if dept_id:
        d = await db.get(Department, dept_id)
        parts.append(f"department “{d.name if d else dept_id}”")
    return f"role “{pretty_role(role)}” in " + " / ".join(parts)


async def assert_new_seats_free(db: AsyncSession, user: User, before: set[Seat]) -> None:
    """Raise 409 if `user` now holds a seat they didn't hold in `before`
    that somebody else already holds. Only newly added seats are checked, so
    saving an unrelated change never fails because of an old duplicate.
    Call after the change has been flushed, before commit. A per-seat
    advisory lock makes two simultaneous assignments of one seat take turns,
    so the second sees the first."""
    after = await seats_of_user(db, user)
    many = await multi_holder_roles(db)
    for seat in sorted(after - before, key=str):
        role, estb_id, dept_id = seat
        if role in many:
            continue  # Super Admin allowed several holders for this role
        await db.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
            {"k": f"seat:{role}:{estb_id}:{dept_id}"},
        )
        others = (await db.execute(
            select(UserRole).options(selectinload(UserRole.user))
            .where(UserRole.role == role, UserRole.user_id != user.id)
        )).scalars().all()
        for ur in others:
            holder = ur.user
            # A retired person has handed the seat over — it is free again.
            if holder is None or holder.origin_user_id is not None or holder.is_retired:
                continue
            if seat_of(holder, ur) == seat:
                status = "" if holder.is_active else " (a deactivated account)"
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"The {await _seat_label(db, seat)} is already assigned to "
                        f"{holder.full_name} ({holder.email}){status}. Each role in an "
                        f"establishment's department can have only one holder — remove it "
                        f"from them first, or use Transfer Ownership."
                    ),
                )


async def duplicate_seat_reasons(db: AsyncSession, role_name: str, limit: int = 6) -> list[str]:
    """Seats of `role_name` that already have more than one holder — used to
    refuse switching a role back to one-holder-only while that is untrue."""
    rows = (await db.execute(
        select(UserRole).options(selectinload(UserRole.user)).where(UserRole.role == role_name)
    )).scalars().all()
    seats: dict[Seat, list[User]] = {}
    for ur in rows:
        holder = ur.user
        if holder is None or holder.origin_user_id is not None or holder.is_retired:
            continue
        seat = seat_of(holder, ur)
        if seat is not None and all(h.id != holder.id for h in seats.get(seat, [])):
            seats.setdefault(seat, []).append(holder)
    out: list[str] = []
    for seat, holders in seats.items():
        if len(holders) > 1:
            who = ", ".join(f"{h.full_name} ({h.email})" for h in holders)
            out.append(f"The {await _seat_label(db, seat)} is held by {len(holders)} people: {who}.")
    shown = out[:limit]
    if len(out) > limit:
        shown.append(f"…and {len(out) - limit} more.")
    return shown
