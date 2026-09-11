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

Idempotent (`IF NOT EXISTS`) for the same reason as 0015 — see that
revision's docstring.
"""
from typing import Sequence, Union
from alembic import op

revision: str = "0016"
down_revision: Union[str, None] = "0015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE users ADD COLUMN IF NOT EXISTS account_predecessor_id UUID REFERENCES users(id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_users_account_predecessor_id ON users (account_predecessor_id)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_users_account_predecessor_id")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS account_predecessor_id")
