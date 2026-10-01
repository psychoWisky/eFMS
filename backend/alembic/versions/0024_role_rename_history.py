"""Role rename history + "formerly" on file routing history.

Renaming a custom role used to update only the people holding it; the role
name stamped on files (creator_role / current_holder_role / recipient_role)
and on routing entries kept the OLD name, so those files stopped matching
anyone's role and vanished from Docket / My Files. The rename now carries the
files along, and this migration adds what is needed to say so:

- role_renames: one row per rename (role_id, old_name, new_name, renamed_at,
  show_formerly), for the "New Name (formerly Old Name)" label on the Roles
  screen. show_formerly records the Super Admin's choice at rename time:
  show the old name as "formerly", or show only the new name.
- route_entries.from_role_formerly / to_role_formerly: the name a role had
  when that hop was recorded, kept only on hops that predate a rename, for
  the same label on file history.

Revision ID: 0024
Revises: 0023
Create Date: 2026-10-02
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0024"
down_revision: Union[str, None] = "0023"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "role_renames",
        sa.Column("id", sa.UUID(as_uuid=True), primary_key=True),
        sa.Column("role_id", sa.UUID(as_uuid=True), sa.ForeignKey("roles.id", ondelete="CASCADE"), nullable=False),
        sa.Column("old_name", sa.String(50), nullable=False),
        sa.Column("new_name", sa.String(50), nullable=False),
        sa.Column("renamed_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("show_formerly", sa.Boolean(), server_default=sa.true(), nullable=False),
    )
    op.create_index("ix_role_renames_role_id", "role_renames", ["role_id"])
    op.add_column("route_entries", sa.Column("from_role_formerly", sa.String(50), nullable=True))
    op.add_column("route_entries", sa.Column("to_role_formerly", sa.String(50), nullable=True))


def downgrade() -> None:
    op.drop_column("route_entries", "to_role_formerly")
    op.drop_column("route_entries", "from_role_formerly")
    op.drop_index("ix_role_renames_role_id", table_name="role_renames")
    op.drop_table("role_renames")
