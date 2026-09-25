"""Per-role workspace scoping for eFMS files (multi-role users).

A file belongs to one role-workspace of its creator (creator_* columns, My
Files) and of its current holder (current_holder_* columns, Docket). The
workspace key is (role, establishment_id, department_id) — the same triple
user_roles is unique on (migration 0020) — because one person may hold the
same role name in two contexts, e.g. eFMS Officer for Establishment A and
eFMS Officer for Establishment B.

The org-context part of the key is only enforced when the user actually
holds their active role in more than one context. A user with one context
per role keeps plain role-name scoping, so an admin editing that user's
department/establishment never makes their existing files disappear.
"""
from sqlalchemy import and_

from app.models.user import User


def role_has_multiple_contexts(user: User) -> bool:
    """True when `user` holds their active role in 2+ org contexts."""
    return sum(1 for ur in (user.roles or []) if ur.role == user.active_role) > 1


def workspace_filter(user: User, role_col, estb_col, dept_col):
    """SQL condition: the file's stamped workspace equals the user's current
    one. NULL-safe (IS NOT DISTINCT FROM), so a context with no department
    still matches files stamped with no department."""
    cond = role_col == user.active_role
    if role_has_multiple_contexts(user):
        cond = and_(
            cond,
            estb_col.is_not_distinct_from(user.establishment_id),
            dept_col.is_not_distinct_from(user.department_id),
        )
    return cond


def role_context(user: User, ur) -> tuple:
    """(establishment_id, department_id) a user works in when acting as the
    user_roles row `ur`. Used both when switching into a role and when
    stamping a forwarded file for a recipient's role, so the two always
    agree. A row with an establishment carries its own department (NULL
    included — a department of another establishment would be wrong). A row
    with no context of its own (legacy) keeps the user's current values."""
    if ur is None:
        return user.establishment_id, user.department_id
    if ur.establishment_id is not None:
        return ur.establishment_id, ur.department_id
    if ur.department_id is not None:
        return user.establishment_id, ur.department_id
    return user.establishment_id, user.department_id
