"""Add users.middle_name (model / migration drift fix).

`User.middle_name` has existed on the SQLAlchemy model (and in
`User.full_name`, `AdminUserOut`, the Create/Edit user forms) for a long
time, but no migration ever added the column — a real drift bug. Any
environment created purely from migrations therefore 500s on login and on
user create/edit ("column users.middle_name does not exist").

This migration closes that gap. `ADD COLUMN IF NOT EXISTS` so it is safe
on databases where the column was already added out-of-band by a manual
ALTER. NULL on every existing row.

Revision ID: 0018
Revises: 0017
Create Date: 2026-09-10
"""
from typing import Sequence, Union
from alembic import op

revision: str = "0018"
down_revision: Union[str, None] = "0017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # IF NOT EXISTS: idempotent — databases that were patched manually
    # already have the column and must not error here.
    op.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS middle_name VARCHAR(100)")


def downgrade() -> None:
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS middle_name")
