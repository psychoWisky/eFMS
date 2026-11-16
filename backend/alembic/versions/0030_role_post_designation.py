"""A "post" is a role in a place PLUS a designation, so one person can hold the
same role in the same establishment/department more than once — told apart by
the designation (e.g. In-charge, Hostel / In-charge, Library).

  * users.active_designation          the post the person is working as now
  * efms_files.creator_designation / current_holder_designation   file workspace
  * route_entries.from_designation / to_designation               who it was sent as
  * user_roles unique index now includes the designation
  * multi_designation_users           the people the Super Admin allowed to hold
                                      the same role more than once in one place

Revision ID: 0030
Revises: 0029
Create Date: 2026-11-16
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0030"
down_revision: Union[str, None] = "0029"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_ZERO = "'00000000-0000-0000-0000-000000000000'::uuid"


def upgrade() -> None:
    op.add_column("users", sa.Column("active_designation", sa.String(100), nullable=True))
    op.add_column("efms_files", sa.Column("creator_designation", sa.String(100), nullable=True))
    op.add_column("efms_files", sa.Column("current_holder_designation", sa.String(100), nullable=True))
    op.add_column("route_entries", sa.Column("from_designation", sa.String(100), nullable=True))
    op.add_column("route_entries", sa.Column("to_designation", sa.String(100), nullable=True))

    op.execute("DROP INDEX IF EXISTS uq_user_role_context")
    op.execute(f"""
        CREATE UNIQUE INDEX uq_user_role_post ON user_roles (
            user_id, role,
            COALESCE(establishment_id, {_ZERO}),
            COALESCE(department_id, {_ZERO}),
            lower(COALESCE(designation, ''))
        )
    """)

    op.create_table(
        "multi_designation_users",
        sa.Column("user_id", sa.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("created_by", sa.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    # Posts that already carry a designation (set from Edit User) keep their
    # files: stamp those files with it, so the Docket / My Files still match.
    op.execute("""
        UPDATE efms_files f SET current_holder_designation = ur.designation
        FROM user_roles ur
        WHERE ur.designation IS NOT NULL
          AND f.current_holder_id = ur.user_id AND f.current_holder_role = ur.role
          AND f.current_holder_establishment_id IS NOT DISTINCT FROM ur.establishment_id
          AND f.current_holder_department_id IS NOT DISTINCT FROM ur.department_id
    """)
    op.execute("""
        UPDATE efms_files f SET creator_designation = ur.designation
        FROM user_roles ur
        WHERE ur.designation IS NOT NULL
          AND f.created_by = ur.user_id AND f.creator_role = ur.role
          AND f.creator_establishment_id IS NOT DISTINCT FROM ur.establishment_id
          AND f.creator_department_id IS NOT DISTINCT FROM ur.department_id
    """)
    # The post each person is working as right now.
    op.execute("""
        UPDATE users u SET active_designation = ur.designation
        FROM user_roles ur
        WHERE ur.user_id = u.id AND ur.role = u.active_role AND ur.designation IS NOT NULL
          AND COALESCE(ur.establishment_id, u.establishment_id) IS NOT DISTINCT FROM u.establishment_id
          AND (ur.establishment_id IS NULL OR ur.department_id IS NOT DISTINCT FROM u.department_id)
    """)


def downgrade() -> None:
    op.drop_table("multi_designation_users")
    op.execute("DROP INDEX IF EXISTS uq_user_role_post")
    op.execute(f"""
        CREATE UNIQUE INDEX uq_user_role_context ON user_roles (
            user_id, role,
            COALESCE(establishment_id, {_ZERO}),
            COALESCE(department_id, {_ZERO})
        )
    """)
    op.drop_column("route_entries", "to_designation")
    op.drop_column("route_entries", "from_designation")
    op.drop_column("efms_files", "current_holder_designation")
    op.drop_column("efms_files", "creator_designation")
    op.drop_column("users", "active_designation")
