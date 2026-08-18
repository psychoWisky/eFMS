"""Add holder_notes table — true per-user Notesheet for the current/past holder

Revision ID: 0008
Revises: 0007
Create Date: 2026-08-17

Distinct from `notesheets` (the creator's single, immutable-once-non-draft
document) and `route_entries.remarks` (per-forward routing annotations) —
every user who has ever held a file gets at most one row here, keyed by
(file_id, user_id). Writable only while that user is the file's current
holder (enforced in the API layer); becomes permanently read-only once the
file is forwarded away from them, but the row is never deleted, so it
remains visible as that holder's historical Notesheet contribution.
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "holder_notes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("efms_files.id"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("content", sa.Text, default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("file_id", "user_id", name="uq_holder_note_file_user"),
    )
    op.create_index("ix_holder_note_file", "holder_notes", ["file_id"])
    op.create_index("ix_holder_note_user", "holder_notes", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_holder_note_user", table_name="holder_notes")
    op.drop_index("ix_holder_note_file", table_name="holder_notes")
    op.drop_table("holder_notes")
