"""Optional designation per role a person holds (user_roles.designation) —
e.g. a Professor's extra role "hod" can carry "Head of Department".
NULL means the person's own designation is used.

Revision ID: 0029
Revises: 0028
Create Date: 2026-11-04
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0029"
down_revision: Union[str, None] = "0028"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("user_roles", sa.Column("designation", sa.String(100), nullable=True))


def downgrade() -> None:
    op.drop_column("user_roles", "designation")
