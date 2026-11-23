"""Signature permission is given per post (role + place + designation).

Until now `users.can_sign` was one switch for the whole person. Not every role
a person holds should be allowed to sign, so the permission moves to the post
(`user_roles.can_sign`). Everyone who could sign before keeps signing in all
the posts they hold (so nothing changes until the Super Admin narrows it).

Revision ID: 0032
Revises: 0031
Create Date: 2026-11-23
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0032"
down_revision: Union[str, None] = "0031"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("user_roles", sa.Column("can_sign", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.execute("UPDATE user_roles SET can_sign = true WHERE user_id IN (SELECT id FROM users WHERE can_sign = true)")


def downgrade() -> None:
    op.drop_column("user_roles", "can_sign")
