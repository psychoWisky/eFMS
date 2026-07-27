"""Add digital signature support: can_sign on users, file_signatures table

Revision ID: 0002
Revises: 0001
Create Date: 2026-06-05
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add can_sign permission flag to users
    op.add_column("users", sa.Column("can_sign", sa.Boolean(), nullable=False, server_default="false"))

    # Create file_signatures table
    op.create_table(
        "file_signatures",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("efms_files.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("pos_x", sa.Float(), nullable=False),
        sa.Column("pos_y", sa.Float(), nullable=False),
        sa.Column("page_number", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("signed_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_file_signatures_file_id", "file_signatures", ["file_id"])
    op.create_index("ix_file_signatures_user_id", "file_signatures", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_file_signatures_user_id", "file_signatures")
    op.drop_index("ix_file_signatures_file_id", "file_signatures")
    op.drop_table("file_signatures")
    op.drop_column("users", "can_sign")
