"""Add user deactivation metadata: reason type, remarks, timestamp, actor.

Revision ID: 0009
Revises: 0008
Create Date: 2026-08-21

User.is_active already gates authentication/authorization (unchanged here).
These four nullable columns only record why/when/by-whom a user was
deactivated, for display and audit purposes — existing rows all receive
NULL, which is a no-op for every existing active/inactive user.
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0009"
down_revision: Union[str, None] = "0008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_reason_enum = postgresql.ENUM(
    "retired", "transferred", "resigned", "left_organization", "suspended", "other",
    name="deactivation_reason_type_enum",
)


def upgrade() -> None:
    _reason_enum.create(op.get_bind(), checkfirst=True)
    op.add_column(
        "users",
        sa.Column("deactivation_reason_type", _reason_enum, nullable=True),
    )
    op.add_column("users", sa.Column("deactivation_remarks", sa.String(1000), nullable=True))
    op.add_column("users", sa.Column("deactivated_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "users",
        sa.Column("deactivated_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("users", "deactivated_by")
    op.drop_column("users", "deactivated_at")
    op.drop_column("users", "deactivation_remarks")
    op.drop_column("users", "deactivation_reason_type")
    _reason_enum.drop(op.get_bind(), checkfirst=True)
