"""Optional free-text description on efms_files.

Entered on New File just below the subject (no length limit, optional) and
printed on the Notesheet PDF under the subject — "No description provided"
when empty.

Revision ID: 0023
Revises: 0022
Create Date: 2026-09-26
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0023"
down_revision: Union[str, None] = "0022"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("efms_files", sa.Column("description", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("efms_files", "description")
