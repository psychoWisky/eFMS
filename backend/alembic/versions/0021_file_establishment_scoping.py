"""Stamp efms_files with the creator's / current holder's org context for
multi-role workspace scoping.

Problem: a role name (e.g. "efms_officer") is not unique per person — since
0020 a user may hold "efms_officer" in Establishment A and again in
Establishment B (or in two departments). Scoping My Files / Docket by the
role-name string alone (creator_role / current_holder_role) made both of
those role-workspaces show the same files.

Fix: store the establishment_id and department_id of the workspace the file
was created in / is currently held in, next to the role name. The workspace
key is (role, establishment_id, department_id) — the same triple user_roles
is unique on. See app/utils/workspace.py.

Revision ID: 0021
Revises: 0020
Create Date: 2026-09-25
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0021"
down_revision: Union[str, None] = "0020"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for prefix in ("creator", "current_holder"):
        op.add_column(
            "efms_files",
            sa.Column(f"{prefix}_establishment_id", sa.UUID(as_uuid=True),
                      sa.ForeignKey("establishments.id"), nullable=True),
        )
        op.add_column(
            "efms_files",
            sa.Column(f"{prefix}_department_id", sa.UUID(as_uuid=True),
                      sa.ForeignKey("departments.id"), nullable=True),
        )

    # Backfill: stamp each file with its creator's / current holder's org
    # context as it stands now. No per-file context was recorded before
    # this migration, and every file predates multi-context roles, so the
    # person's current context is the workspace those files belong to.
    op.execute(
        """
        UPDATE efms_files f
        SET creator_establishment_id = u.establishment_id,
            creator_department_id = u.department_id
        FROM users u
        WHERE f.created_by = u.id
        """
    )
    op.execute(
        """
        UPDATE efms_files f
        SET current_holder_establishment_id = u.establishment_id,
            current_holder_department_id = u.department_id
        FROM users u
        WHERE f.current_holder_id = u.id
        """
    )


def downgrade() -> None:
    op.drop_column("efms_files", "current_holder_department_id")
    op.drop_column("efms_files", "current_holder_establishment_id")
    op.drop_column("efms_files", "creator_department_id")
    op.drop_column("efms_files", "creator_establishment_id")
