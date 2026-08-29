"""Project-number generation: replace count()+1 with a Postgres sequence.

The previous approach in app/api/v1/endpoints/projects.py
(_generate_project_number) read `SELECT COUNT(*) FROM projects` and used
count+1 as the new project_number. Two concurrent POST /projects requests
could both read the same count before either committed, producing the same
number — the projects.project_number UNIQUE constraint would then reject
the second insert with an unhandled IntegrityError (a raw 500) instead of
either request succeeding cleanly.

This migration adds a dedicated sequence, `project_number_seq`. nextval()
on a Postgres sequence is atomic and safe under arbitrary concurrency by
design — no application-level locking is introduced. The sequence is
seeded to continue after the highest EXISTING numeric project_number, so
already-assigned numbers are never reused or altered.

No schema change to the `projects` table itself: `project_number` stays the
same column/type with the same UNIQUE constraint; the externally visible
format (a plain incrementing integer string) is unchanged.

Revision ID: 0014
Revises: 0013
Create Date: 2026-08-29
"""
from typing import Sequence, Union
from alembic import op

revision: str = "0014"
down_revision: Union[str, None] = "0013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("CREATE SEQUENCE IF NOT EXISTS project_number_seq START WITH 1 INCREMENT BY 1")
    # Advance the sequence past any already-assigned numeric project
    # numbers so the very next nextval() call can never collide with an
    # existing row. is_called=false means the next nextval() returns this
    # value exactly, not value+1.
    op.execute(
        """
        SELECT setval(
            'project_number_seq',
            GREATEST(1, COALESCE((SELECT MAX(project_number::bigint) FROM projects WHERE project_number ~ '^[0-9]+$'), 0) + 1),
            false
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP SEQUENCE IF EXISTS project_number_seq")
