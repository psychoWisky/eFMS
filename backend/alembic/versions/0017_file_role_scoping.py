"""Per-role file queues for multi-role users.

A person who holds several roles gets a separate workspace per role: a file
they receive or create while acting as "Registrar" does not appear when
they switch to their "HoD" role.

Adds four nullable text columns:
  * efms_files.creator_role         — the creator's active role at creation
  * efms_files.current_holder_role  — the current holder's active role
  * route_entries.from_role         — sender's role at that hop
  * route_entries.to_role           — recipient's role at that hop

NULL everywhere on existing rows (the single-role era). Every query that
scopes by role treats NULL as "matches any role", so pre-migration files
and single-role users behave exactly as before — the filter only bites
once a file actually carries a role.

Revision ID: 0017
Revises: 0016
Create Date: 2026-09-09
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0017"
down_revision: Union[str, None] = "0016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("efms_files", sa.Column("creator_role", sa.String(50), nullable=True))
    op.add_column("efms_files", sa.Column("current_holder_role", sa.String(50), nullable=True))
    op.add_column("route_entries", sa.Column("from_role", sa.String(50), nullable=True))
    op.add_column("route_entries", sa.Column("to_role", sa.String(50), nullable=True))


def downgrade() -> None:
    op.drop_column("route_entries", "to_role")
    op.drop_column("route_entries", "from_role")
    op.drop_column("efms_files", "current_holder_role")
    op.drop_column("efms_files", "creator_role")
