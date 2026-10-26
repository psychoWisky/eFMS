"""FOC: the project carries the FOC in-charge (replaces the free-text P.I.),
and the Assistant Comptroller / Finance Officer / Vice Chancellor come from
eFMS roles (foc_role_links) instead of being picked person by person.

Revision ID: 0028
Revises: 0027
Create Date: 2026-10-26
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0028"
down_revision: Union[str, None] = "0027"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("foc_projects", sa.Column("incharge_id", sa.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True))
    # Fill the new column from the project's existing FOCs (latest one wins).
    op.execute("""
        UPDATE foc_projects p SET incharge_id = s.incharge_id
        FROM (SELECT DISTINCT ON (project_id) project_id, incharge_id FROM foc_sheets
              ORDER BY project_id, created_at DESC) s
        WHERE s.project_id = p.id
    """)
    op.drop_column("foc_projects", "pi_name")

    op.create_table(
        "foc_role_links",
        sa.Column("role", sa.String(30), primary_key=True),
        sa.Column("efms_role_id", sa.UUID(as_uuid=True), sa.ForeignKey("roles.id", ondelete="SET NULL"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    # Fixed officers now come from eFMS roles; foc_officers keeps the DDOs.
    op.execute("DELETE FROM foc_officers WHERE role <> 'ddo'")
    op.drop_index("uq_foc_officer_fixed_role", table_name="foc_officers")


def downgrade() -> None:
    op.create_index("uq_foc_officer_fixed_role", "foc_officers", ["role"], unique=True,
                    postgresql_where=sa.text("role <> 'ddo'"))
    op.drop_table("foc_role_links")
    op.add_column("foc_projects", sa.Column("pi_name", sa.String(200), nullable=True))
    op.drop_column("foc_projects", "incharge_id")
