"""Per-role department / establishment on user_roles (multi-role users).

A person can now hold several roles and switch between them (see
POST /auth/switch-role). Each held role may belong to a *different*
organizational context — e.g. Registrar in the HQ establishment,
Head of Department in a specific college department. This migration adds
two nullable FK columns to `user_roles`:

  * department_id     -> departments.id
  * establishment_id  -> establishments.id

Both NULL on every existing row and for any role added without an explicit
context: the code falls back to the user record's own
department_id / establishment_id in that case, so behaviour for
single-role users is completely unchanged. No backfill.

Revision ID: 0015
Revises: 0014
Create Date: 2026-09-09

Idempotent (`ADD COLUMN IF NOT EXISTS`): some environments received these
columns via an out-of-band manual patch before `alembic_version` was
updated, which made a plain `ADD COLUMN` fail with DuplicateColumnError on
`alembic upgrade head`. Using raw DDL here (SQLAlchemy's op.add_column has
no IF NOT EXISTS option) makes re-running this revision a safe no-op.
"""
from typing import Sequence, Union
from alembic import op

revision: str = "0015"
down_revision: Union[str, None] = "0014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id)"
    )
    op.execute(
        "ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS establishment_id UUID REFERENCES establishments(id)"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE user_roles DROP COLUMN IF EXISTS establishment_id")
    op.execute("ALTER TABLE user_roles DROP COLUMN IF EXISTS department_id")
