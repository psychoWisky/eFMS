"""Add recipient_id and recipient_name columns to efms_files

Revision ID: 0004
Revises: 0003
Create Date: 2026-06-15
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("efms_files", sa.Column("recipient_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True))
    op.add_column("efms_files", sa.Column("recipient_name", sa.String(200), nullable=True))


def downgrade() -> None:
    op.drop_column("efms_files", "recipient_name")
    op.drop_column("efms_files", "recipient_id")
