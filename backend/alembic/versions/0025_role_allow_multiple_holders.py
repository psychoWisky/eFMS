"""Per-role switch: may several people hold this role in the same
establishment + department?

Until now every role was treated as "one holder per (role, establishment,
department)" (see app/utils/integrity.py). Roles like Faculty or Student
obviously have many people in one department, so the Super Admin now decides
per role. Default is one-holder-only; roles that are plainly many-person
today (faculty, student, employee(s)) start out as many-holder.

Revision ID: 0025
Revises: 0024
Create Date: 2026-10-04
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0025"
down_revision: Union[str, None] = "0024"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "roles",
        sa.Column("allow_multiple_holders", sa.Boolean(), server_default=sa.false(), nullable=False),
    )
    op.execute(
        "UPDATE roles SET allow_multiple_holders = true "
        "WHERE lower(name) IN ('faculty', 'student', 'employee', 'employees')"
    )


def downgrade() -> None:
    op.drop_column("roles", "allow_multiple_holders")
