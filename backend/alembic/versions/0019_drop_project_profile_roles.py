"""Remove stale user_roles rows belonging to project (PI) profiles.

A PI profile is a project identity, not a person — the real person behind
it (users.origin_user_id) already holds the role. An earlier version of
_create_project_profile (app/api/v1/endpoints/projects.py) copied the
origin's entire role set into the profile's own user_roles so the profile
could use Switch Role too. That's been removed going forward (this
migration is data-only; the code no longer creates these rows at all —
see 0020's sibling commit), but every profile created before that fix
still carries its old copied rows.

This mattered beyond an unused feature: those leftover rows made a PI
profile count as an independent "holder" of every role the origin person
had AT ASSIGNMENT TIME — permanently, even after the origin's real role
later changed — which is exactly why Role Management's user_count showed
roles like "Member" with several holders when zero real people held that
role. Deleting them fixes the existing data; the code fix (this migration
ships alongside) stops it from happening again.

Purely a DELETE scoped to user_roles rows whose user_id belongs to a
project profile — no other table touched, nothing added/removed from the
schema. Not reversible (the deleted rows were themselves derived data, a
one-time snapshot taken at profile-creation time that nothing else reads
independently), so downgrade is a no-op.

Revision ID: 0019
Revises: 0018
Create Date: 2026-09-12
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
        DELETE FROM user_roles
        WHERE user_id IN (SELECT id FROM users WHERE origin_user_id IS NOT NULL)
        """
    )


def downgrade() -> None:
    # Not reversible — the deleted rows were a point-in-time snapshot of
    # each profile's origin's roles at profile-creation time, not
    # independently meaningful data. Nothing to restore them from.
    pass
