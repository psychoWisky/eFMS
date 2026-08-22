"""Un-protect the 11 non-SUPER_ADMIN roles seeded by migration 0010.

Revision ID: 0011
Revises: 0010
Create Date: 2026-08-28

Correction: migration 0010 marked all 12 pre-existing SystemRole values as
is_system=True, treating them as permanent/protected. They are actually
just this project's development/test role data, not AVFU's real
organizational roles or anything the application's authorization logic is
tied to by identity — only SUPER_ADMIN is. This migration re-marks every
role except "super_admin" as is_system=False, so Super Admin can rename or
(once unassigned) delete them like any other role through Role Management.

Safe for existing data: only the is_system flag changes; no role rows,
users, or user_roles assignments are touched.
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0011"
down_revision: Union[str, None] = "0010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

roles_table = sa.table("roles", sa.column("name", sa.String), sa.column("is_system", sa.Boolean))


def upgrade() -> None:
    op.execute(roles_table.update().where(roles_table.c.name != "super_admin").values(is_system=False))


def downgrade() -> None:
    _LEGACY_NAMES = [
        "admin", "hod", "faculty", "student", "academic_cell", "dpgs", "result_branch",
        "efms_officer", "efms_admin", "registrar", "dispatch_officer",
    ]
    op.execute(roles_table.update().where(roles_table.c.name.in_(_LEGACY_NAMES)).values(is_system=True))
