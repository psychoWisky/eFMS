"""Backfill NULL creator_role / current_holder_role on pre-existing files.

Every file created or forwarded through the current code always gets a
real role stamped on it (create_file sets creator_role from the actor's
active_role; route_file's Forward branch resolves and sets
current_holder_role for the recipient). NULL on either column only ever
happens for files that existed before role-scoping was added (migration
0017) and were never touched by the new code since.

Until now, NULL was treated as "show in every role" (a permanent
fallback in list_files/my_docket's query logic) — which is exactly why a
person who is later given a NEW secondary role would still see their OLD
role's pre-existing files bleed into the new role's workspace: those old
files' NULL stamps matched every role, including one that didn't even
exist for that person yet when the file was created.

This migration closes that gap at the data level: every file's NULL role
column is backfilled to its current holder's / creator's real CURRENT
active_role (the best available source of truth — no historical
per-file role was ever recorded before this session's role-scoping
feature existed, so "what role do they hold right now" is the correct,
intentional choice here, not a guess). The application code's NULL-
fallback in the query layer is removed in the same change (see
list_files / my_docket) — after this backfill, NULL should not occur
again in normal operation, so treating it as "any role" is no longer
needed and was actively causing the cross-role leakage bug.

A file whose holder/creator has since been deactivated, or has no
active_role for some other reason, is left NULL by this migration (there
is nothing correct to backfill it to) — the query-layer change still
excludes it from role-scoped views for an ACTIVE role switch, which is
correct: a role-stamped-nothing file belongs to no particular role
workspace and is still reachable via My Files/Docket's non-role-filtered
paths (i.e. by whoever currently holds/created it, regardless of role,
same as before) and via Tracking History regardless.

Revision ID: 0019
Revises: 0018
Create Date: 2026-09-16
"""
from typing import Sequence, Union
from alembic import op

revision: str = "0019"
down_revision: Union[str, None] = "0018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE efms_files f
        SET current_holder_role = u.active_role
        FROM users u
        WHERE f.current_holder_id = u.id
          AND f.current_holder_role IS NULL
          AND u.active_role IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE efms_files f
        SET creator_role = u.active_role
        FROM users u
        WHERE f.created_by = u.id
          AND f.creator_role IS NULL
          AND u.active_role IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE route_entries r
        SET to_role = u.active_role
        FROM users u
        WHERE r.to_user_id = u.id
          AND r.to_role IS NULL
          AND u.active_role IS NOT NULL
        """
    )
    op.execute(
        """
        UPDATE route_entries r
        SET from_role = u.active_role
        FROM users u
        WHERE r.from_user_id = u.id
          AND r.from_role IS NULL
          AND u.active_role IS NOT NULL
        """
    )


def downgrade() -> None:
    # Not reversible — the original NULLs carried no information (they
    # meant "predates role-scoping entirely"), so there is nothing
    # correct to restore them to. A downgrade would have to guess which
    # rows were NULL before, which this migration has no way to know.
    pass
