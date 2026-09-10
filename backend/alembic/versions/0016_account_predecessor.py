"""Account ownership transfer — users.account_predecessor_id.

When a person leaves a role and a successor takes over, the super admin
runs a transfer: the successor's `account_predecessor_id` is set to the
leaving user's id, the leaving user is deactivated (kept forever for
historical attribution), and every file the leaver currently held is
re-pointed to the successor (with a route entry recording the hand-off).

`account_predecessor_id` is followed as a chain by the file-access checks
so the successor can open everything the predecessor could — their created
files, their holding-period notes, the routing history they were part of.
Nothing about existing rows changes: NULL on every user today.

Revision ID: 0016
Revises: 0015
Create Date: 2026-09-09
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0016"
down_revision: Union[str, None] = "0015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("account_predecessor_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
    )
    op.create_index("ix_users_account_predecessor_id", "users", ["account_predecessor_id"])


def downgrade() -> None:
    op.drop_index("ix_users_account_predecessor_id", table_name="users")
    op.drop_column("users", "account_predecessor_id")
