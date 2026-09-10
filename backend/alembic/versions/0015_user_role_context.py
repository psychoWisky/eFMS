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
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0015"
down_revision: Union[str, None] = "0014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "user_roles",
        sa.Column("department_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("departments.id"), nullable=True),
    )
    op.add_column(
        "user_roles",
        sa.Column("establishment_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("establishments.id"), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("user_roles", "establishment_id")
    op.drop_column("user_roles", "department_id")
