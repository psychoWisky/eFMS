"""Allow same role across different establishments/departments on user_roles.

Previously, user_roles had a unique constraint on (user_id, role), which
prevented a user from holding the same role in two different departments
(e.g., Head of Department for Department A and Head of Department for Department B).

This migration replaces uq_user_role with a scoped unique index on
(user_id, role, establishment_id, department_id), treating NULL as a distinct
default placeholder so a user cannot be assigned the exact same role in the
exact same organizational context twice, but can hold the role in different
contexts.

Revision ID: 0020
Revises: 0019
Create Date: 2026-09-25
"""
from typing import Sequence, Union
from alembic import op

revision: str = "0020"
down_revision: Union[str, None] = "0019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Drop the legacy (user_id, role) uniqueness constraint
    op.execute("ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS uq_user_role")

    # Create composite uniqueness index including establishment and department
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_user_role_context ON user_roles (
            user_id,
            role,
            (COALESCE(establishment_id, '00000000-0000-0000-0000-000000000000'::uuid)),
            (COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid))
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_user_role_context")
    op.execute("ALTER TABLE user_roles ADD CONSTRAINT uq_user_role UNIQUE (user_id, role)")
