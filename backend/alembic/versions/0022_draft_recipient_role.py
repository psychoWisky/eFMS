"""Remember which of the draft recipient's roles was picked.

A draft stored only recipient_id (the person). For a recipient holding
several roles — or the same role in several establishments/departments —
the first Forward of the draft then went to whatever role that person was
currently acting in, not the one the creator picked. Store the picked role
name and the exact user_roles row next to recipient_id.

recipient_user_role_id is ON DELETE SET NULL: if that role is later removed
or transferred away, the draft falls back to the role name / the
recipient's current role, same as before this migration.

Revision ID: 0022
Revises: 0021
Create Date: 2026-09-26
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0022"
down_revision: Union[str, None] = "0021"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("efms_files", sa.Column("recipient_role", sa.String(50), nullable=True))
    op.add_column(
        "efms_files",
        sa.Column("recipient_user_role_id", sa.UUID(as_uuid=True),
                  sa.ForeignKey("user_roles.id", ondelete="SET NULL"), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("efms_files", "recipient_user_role_id")
    op.drop_column("efms_files", "recipient_role")
