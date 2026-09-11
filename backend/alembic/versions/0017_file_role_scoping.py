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

Idempotent (`IF NOT EXISTS`) for the same reason as 0015 — see that
revision's docstring.
"""
from typing import Sequence, Union
from alembic import op

revision: str = "0017"
down_revision: Union[str, None] = "0016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE efms_files ADD COLUMN IF NOT EXISTS creator_role VARCHAR(50)")
    op.execute("ALTER TABLE efms_files ADD COLUMN IF NOT EXISTS current_holder_role VARCHAR(50)")
    op.execute("ALTER TABLE route_entries ADD COLUMN IF NOT EXISTS from_role VARCHAR(50)")
    op.execute("ALTER TABLE route_entries ADD COLUMN IF NOT EXISTS to_role VARCHAR(50)")


def downgrade() -> None:
    op.execute("ALTER TABLE route_entries DROP COLUMN IF EXISTS to_role")
    op.execute("ALTER TABLE route_entries DROP COLUMN IF EXISTS from_role")
    op.execute("ALTER TABLE efms_files DROP COLUMN IF EXISTS current_holder_role")
    op.execute("ALTER TABLE efms_files DROP COLUMN IF EXISTS creator_role")
