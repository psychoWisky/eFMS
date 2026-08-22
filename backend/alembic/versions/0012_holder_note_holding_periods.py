"""HolderNote: support one row per holding PERIOD, not per (file, user).

Revision ID: 0012
Revises: 0011
Create Date: 2026-08-29

Why: a user who holds a file more than once (A -> B -> C -> A) previously
overwrote their own earlier HolderNote on return, because the table only
ever allowed one row per (file_id, user_id). This migration:

  1. Adds `sequence` (int, NOT NULL) — the stable, chronological
     holding-period number used for display numbering. Number 1 is reserved
     for the creator's immutable initial Notesheet (a separate table,
     unaffected by this migration); the first HolderNote row for a file is
     therefore numbered 2, the next 3, and so on.
  2. Adds `is_current` (bool, NOT NULL) — marks the single holding-period
     row that is still editable (belongs to the file's live
     current_holder_id). Enforced by a new partial unique index: at most one
     is_current=true row per file at a time.
  3. Drops the old `uq_holder_note_file_user` unique constraint, since a
     user can now legitimately have multiple rows for the same file (one
     per holding period).

Backfill strategy for the 3 existing rows in this environment (documented
per the implementation report — see there for the "no fake history" caveat):
  - `sequence` is assigned per file by existing `created_at` order (2, 3, 4...),
    which is the best available approximation of holding-period order for
    data that predates this feature.
  - `is_current` is set true for whichever existing row's `user_id` matches
    the file's actual current `current_holder_id` (if any) and false for
    every other row. This does not invent new holding periods or content —
    every existing row is preserved exactly as-is, just reclassified as
    current or historical based on data that already exists elsewhere
    (EfmsFile.current_holder_id). A file whose current holder has never
    saved a HolderNote row ends up with no is_current=true row at all,
    which is safe and self-heals on their first save (see
    save_my_holder_notesheet in efms_files.py).
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0012"
down_revision: Union[str, None] = "0011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_constraint("uq_holder_note_file_user", "holder_notes", type_="unique")

    op.add_column("holder_notes", sa.Column("sequence", sa.Integer(), nullable=True))
    op.add_column("holder_notes", sa.Column("is_current", sa.Boolean(), nullable=False, server_default=sa.true()))

    # sequence: 2, 3, 4... per file, ordered by existing created_at — the
    # best available proxy for holding-period order in pre-existing data.
    op.execute("""
        UPDATE holder_notes
        SET sequence = sub.rn
        FROM (
            SELECT id, 1 + ROW_NUMBER() OVER (PARTITION BY file_id ORDER BY created_at) AS rn
            FROM holder_notes
        ) AS sub
        WHERE holder_notes.id = sub.id
    """)

    # is_current: true only for the row matching the file's actual current
    # holder; false for every other pre-existing row.
    op.execute("UPDATE holder_notes SET is_current = false")
    op.execute("""
        UPDATE holder_notes hn
        SET is_current = true
        FROM efms_files f
        WHERE hn.file_id = f.id
          AND f.current_holder_id IS NOT NULL
          AND hn.user_id = f.current_holder_id
    """)

    op.alter_column("holder_notes", "sequence", nullable=False)
    op.alter_column("holder_notes", "is_current", server_default=None)

    op.create_index(
        "uq_holder_note_current_per_file", "holder_notes", ["file_id"],
        unique=True, postgresql_where=sa.text("is_current = true"),
    )


def downgrade() -> None:
    op.drop_index("uq_holder_note_current_per_file", table_name="holder_notes")
    op.drop_column("holder_notes", "is_current")
    op.drop_column("holder_notes", "sequence")
    # Best-effort only: if real holding-period history has since been
    # created (more than one row per (file, user)), this unique constraint
    # cannot be restored until the duplicates are resolved manually.
    op.create_unique_constraint("uq_holder_note_file_user", "holder_notes", ["file_id", "user_id"])
