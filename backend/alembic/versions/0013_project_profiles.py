"""Project-specific user profiles (PI profiles).

Adds:
  1. `projects` table — project metadata (number, name, funding, dates,
     status) plus `current_profile_id` pointing at whichever `users` row
     presently represents the project's PI.
  2. `users.origin_user_id` / `users.project_id` — both nullable, purely
     additive. NULL on every existing row (no backfill needed or
     performed): every pre-existing user is unambiguously an
     original/person identity, exactly as before this migration. A
     project-profile row is only ever created going forward, by
     POST /projects/{id}/assign.
  3. A check constraint enforcing origin_user_id/project_id are both set
     or both NULL together.

No existing table's ownership/routing columns (efms_files.created_by/
current_holder_id, route_entries.from_user_id/to_user_id,
file_attachments.uploaded_by, holder_notes.user_id, notesheets.*) are
touched — a project profile is deliberately "just another users.id" to
every one of them.

Revision ID: 0013
Revises: 0012
Create Date: 2026-08-28
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0013"
down_revision: Union[str, None] = "0012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "projects",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("project_number", sa.String(50), nullable=False, unique=True),
        sa.Column("name", sa.String(300), nullable=False),
        sa.Column("total_funding", sa.Numeric(14, 2), nullable=True),
        sa.Column("funding_agency", sa.String(300), nullable=True),
        sa.Column("start_date", sa.Date(), nullable=True),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column("status", sa.Enum("active", "completed", name="project_status_enum"), nullable=False, server_default="active"),
        sa.Column("current_profile_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.add_column("users", sa.Column("origin_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True))
    op.add_column("users", sa.Column("project_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("projects.id"), nullable=True))
    op.create_index("ix_users_origin_user_id", "users", ["origin_user_id"])

    op.create_check_constraint(
        "ck_user_profile_origin_project_pair",
        "users",
        "(origin_user_id IS NULL) = (project_id IS NULL)",
    )


def downgrade() -> None:
    op.drop_constraint("ck_user_profile_origin_project_pair", "users", type_="check")
    op.drop_index("ix_users_origin_user_id", table_name="users")
    op.drop_column("users", "project_id")
    op.drop_column("users", "origin_user_id")
    op.drop_table("projects")
    op.execute("DROP TYPE IF EXISTS project_status_enum")
