"""Simplify eFMS workflow to Draft/Active/Released; remove Approve/Reject/Return

Revision ID: 0005
Revises: 0004
Create Date: 2026-07-27

Dev-only cleanup (no production users, backward compatibility not required):
- route_entries.action loses 'approve', 'reject', 'return_' -> rows using them are deleted.
- efms_files.status loses 'pending', 'under_review', 'approved', 'rejected',
  'archived', 'locked' -> collapsed into 'active' (the file remains wherever it
  currently sits in the workflow; 'draft' and 'dispatched' pass through unchanged).
"""
from typing import Sequence, Union
from alembic import op

revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Drop route_entries rows using actions that no longer exist.
    op.execute("DELETE FROM route_entries WHERE action::text IN ('approve', 'reject', 'return_')")

    # Park obsolete file statuses on 'pending' (a value that still exists in the
    # OLD enum) so the later cast to the new enum can map it to 'active'.
    op.execute("""
        UPDATE efms_files
        SET status = 'pending'
        WHERE status::text IN ('under_review', 'approved', 'rejected', 'archived', 'locked')
    """)

    # Rebuild route_action_enum with only the surviving actions.
    op.execute("ALTER TYPE route_action_enum RENAME TO route_action_enum_old")
    op.execute("CREATE TYPE route_action_enum AS ENUM ('forward', 'dispatch')")
    op.execute("ALTER TABLE route_entries ALTER COLUMN action DROP DEFAULT")
    op.execute(
        "ALTER TABLE route_entries ALTER COLUMN action TYPE route_action_enum "
        "USING action::text::route_action_enum"
    )
    op.execute("DROP TYPE route_action_enum_old")

    # Rebuild file_status_enum with only draft/active/dispatched.
    op.execute("ALTER TYPE file_status_enum RENAME TO file_status_enum_old")
    op.execute("CREATE TYPE file_status_enum AS ENUM ('draft', 'active', 'dispatched')")
    op.execute("ALTER TABLE efms_files ALTER COLUMN status DROP DEFAULT")
    op.execute("""
        ALTER TABLE efms_files ALTER COLUMN status TYPE file_status_enum
        USING (CASE status::text WHEN 'pending' THEN 'active' ELSE status::text END)::file_status_enum
    """)
    op.execute("ALTER TABLE efms_files ALTER COLUMN status SET DEFAULT 'draft'")
    op.execute("DROP TYPE file_status_enum_old")


def downgrade() -> None:
    # Not supported: obsolete workflow states are not preserved (dev-only schema).
    raise NotImplementedError("Downgrade not supported for the workflow-simplification migration.")
