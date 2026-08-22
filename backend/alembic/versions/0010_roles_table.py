"""Add roles table for Role Management; widen users.active_role and
user_roles.role from the Postgres `system_role` enum to plain VARCHAR.

Revision ID: 0010
Revises: 0009
Create Date: 2026-08-25

Why widen the columns: a Postgres native ENUM type can only hold a fixed,
schema-migration-defined set of values — it cannot represent a role a Super
Admin creates at runtime through the new Role Management UI. Widening to
VARCHAR(50) is backward compatible: every existing row's value is preserved
verbatim (`USING active_role::text` / `USING role::text`), and every
application-level comparison against SystemRole enum members continues to
work unchanged (SystemRole is a `str` subclass, so its members compare and
hash equal to plain strings — see app/models/user.py).

The old `system_role` Postgres enum TYPE is deliberately left in place
(unused by any column after this migration) rather than dropped, so this
migration can be safely rolled back without needing to recreate the type,
and so nothing else referencing it by name breaks unexpectedly.

Every pre-existing SystemRole value is seeded into `roles` as a system role
(is_system=True) — these are the roles referenced by hard-coded string
checks elsewhere (dispatch routing, EFMS_ASSIGNABLE_ROLES, frontend nav
arrays), so the app layer refuses to rename or delete them. No existing user
or user_roles row is modified beyond the column type widening; every
existing role assignment is preserved as-is.
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0010"
down_revision: Union[str, None] = "0009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SYSTEM_ROLES = [
    ("super_admin", "Super Administrator — full system administration and file-content access."),
    ("admin", "Legacy administrative role (no special privileges since the Super-Admin-only authorization change)."),
    ("hod", "Head of Department."),
    ("faculty", "Faculty member."),
    ("student", "Student (academic-only role; not assignable in eFMS)."),
    ("academic_cell", "Academic Cell (academic-only role; not assignable in eFMS)."),
    ("dpgs", "DPGS (academic-only role; not assignable in eFMS)."),
    ("result_branch", "Result Branch (academic-only role; not assignable in eFMS)."),
    ("efms_officer", "eFMS Officer."),
    ("efms_admin", "eFMS Admin."),
    ("registrar", "Registrar."),
    ("dispatch_officer", "Dispatch Officer."),
]


def upgrade() -> None:
    op.create_table(
        "roles",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(50), nullable=False),
        sa.Column("description", sa.String(255), nullable=True),
        sa.Column("is_system", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("name", name="uq_role_name"),
    )
    op.create_index("ix_role_name", "roles", ["name"])

    roles_table = sa.table(
        "roles",
        sa.column("id", postgresql.UUID(as_uuid=True)),
        sa.column("name", sa.String),
        sa.column("description", sa.String),
        sa.column("is_system", sa.Boolean),
    )
    import uuid
    op.bulk_insert(roles_table, [
        {"id": uuid.uuid4(), "name": name, "description": desc, "is_system": True}
        for name, desc in _SYSTEM_ROLES
    ])

    op.alter_column(
        "users", "active_role",
        existing_type=postgresql.ENUM(name="system_role", create_type=False),
        type_=sa.String(50),
        postgresql_using="active_role::text",
    )
    op.alter_column(
        "user_roles", "role",
        existing_type=postgresql.ENUM(name="system_role", create_type=False),
        type_=sa.String(50),
        nullable=False,
        postgresql_using="role::text",
    )


def downgrade() -> None:
    existing_enum = postgresql.ENUM(name="system_role", create_type=False)
    op.alter_column(
        "user_roles", "role",
        existing_type=sa.String(50),
        type_=existing_enum,
        nullable=False,
        postgresql_using="role::system_role",
    )
    op.alter_column(
        "users", "active_role",
        existing_type=sa.String(50),
        type_=existing_enum,
        postgresql_using="active_role::system_role",
    )
    op.drop_index("ix_role_name", table_name="roles")
    op.drop_table("roles")
