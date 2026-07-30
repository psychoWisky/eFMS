"""Admin-created-user onboarding: add must_change_password flag.

Revision ID: 0006
Revises: 0005
Create Date: 2026-07-30

Dev-only cleanup (no production users, backward compatibility not required):
- Self-registration is replaced by admin-created accounts with a temporary
  password. Existing users are backfilled with must_change_password=False
  (they already have a real password from the old flow).
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("must_change_password", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.alter_column("users", "must_change_password", server_default=None)


def downgrade() -> None:
    op.drop_column("users", "must_change_password")
