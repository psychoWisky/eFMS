"""Initial schema — all tables

Revision ID: 0001
Revises:
Create Date: 2026-05-18 00:00:00
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Enums ─────────────────────────────────────────────────────────────────
    op.execute("CREATE TYPE system_role AS ENUM ('super_admin','admin','hod','faculty','student','academic_cell','dpgs','result_branch','efms_officer','efms_admin','registrar','dispatch_officer')")
    op.execute("CREATE TYPE gender_enum AS ENUM ('male','female','other','prefer_not_to_say')")
    op.execute("CREATE TYPE course_type_enum AS ENUM ('theory','practical','seminar')")
    op.execute("CREATE TYPE course_status_enum AS ENUM ('active','inactive','archived')")
    op.execute("CREATE TYPE enrollment_status_enum AS ENUM ('pending','approved','rejected','withdrawn')")
    op.execute("CREATE TYPE grade_sheet_status_enum AS ENUM ('draft','submitted','hod_approved','cell_approved','dpgs_approved','published','rejected')")
    op.execute("CREATE TYPE grade_enum AS ENUM ('O','A+','A','B+','B','C','F','AB','MP','I')")
    op.execute("CREATE TYPE thesis_status_enum AS ENUM ('registered','proposal_submitted','proposal_approved','in_progress','submitted','under_review','approved','rejected')")
    op.execute("CREATE TYPE ppw_status_enum AS ENUM ('pending','submitted','approved','rejected')")
    op.execute("CREATE TYPE file_status_enum AS ENUM ('draft','pending','under_review','approved','rejected','dispatched','archived','locked')")
    op.execute("CREATE TYPE file_priority_enum AS ENUM ('normal','urgent','secret')")
    op.execute("CREATE TYPE route_action_enum AS ENUM ('forward','approve','reject','return_','dispatch')")
    op.execute("CREATE TYPE dispatch_mode_enum AS ENUM ('internal','postal','email','courier')")

    # ── Core tables ────────────────────────────────────────────────────────────
    op.create_table("establishments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("code", sa.String(50), unique=True, nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("is_active", sa.Boolean, default=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table("departments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("code", sa.String(50), nullable=False),
        sa.Column("establishment_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("establishments.id"), nullable=False),
        sa.Column("is_active", sa.Boolean, default=True),
        sa.Column("head_of_department_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table("users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("email", sa.String(255), unique=True, nullable=False),
        sa.Column("hashed_password", sa.String(255)),
        sa.Column("google_id", sa.String(255), unique=True, nullable=True),
        sa.Column("is_active", sa.Boolean, default=True),
        sa.Column("kyc_completed", sa.Boolean, default=False),
        sa.Column("active_role", postgresql.ENUM(name="system_role", create_type=False), nullable=True),
        sa.Column("first_name", sa.String(100), nullable=True),
        sa.Column("last_name", sa.String(100), nullable=True),
        sa.Column("date_of_birth", sa.Date, nullable=True),
        sa.Column("gender", postgresql.ENUM(name="gender_enum", create_type=False), nullable=True),
        sa.Column("mobile", sa.String(15), nullable=True),
        sa.Column("employee_code", sa.String(20), nullable=True),
        sa.Column("designation", sa.String(100), nullable=True),
        sa.Column("address_line1", sa.String(255), nullable=True),
        sa.Column("address_line2", sa.String(255), nullable=True),
        sa.Column("city", sa.String(100), nullable=True),
        sa.Column("state", sa.String(100), nullable=True),
        sa.Column("pincode", sa.String(10), nullable=True),
        sa.Column("profile_photo_url", sa.String(500), nullable=True),
        sa.Column("department_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("departments.id"), nullable=True),
        sa.Column("establishment_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("establishments.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table("user_roles",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", postgresql.ENUM(name="system_role", create_type=False), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "role", name="uq_user_role"),
    )

    op.create_table("refresh_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_hash", sa.String(64), unique=True, nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked", sa.Boolean, default=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table("audit_logs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("action", sa.String(100), nullable=False),
        sa.Column("resource", sa.String(100), nullable=True),
        sa.Column("resource_id", sa.String(100), nullable=True),
        sa.Column("details", postgresql.JSONB, nullable=True),
        sa.Column("ip_address", sa.String(50), nullable=True),
        sa.Column("system", sa.String(10), default="AMS"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── AMS Academic tables ────────────────────────────────────────────────────
    op.create_table("academic_semesters",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(60), nullable=False),
        sa.Column("academic_year", sa.String(20), nullable=False),
        sa.Column("is_current", sa.Boolean, default=False),
        sa.Column("start_date", sa.Date),
        sa.Column("end_date", sa.Date),
        sa.Column("enrollment_open", sa.Boolean, default=False),
        sa.Column("grade_entry_open", sa.Boolean, default=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("name", "academic_year", name="uq_semester_year"),
    )

    op.create_table("courses",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("code", sa.String(20), nullable=False),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("credits", sa.Integer, nullable=False),
        sa.Column("course_type", postgresql.ENUM(name="course_type_enum", create_type=False), default="theory"),
        sa.Column("status", postgresql.ENUM(name="course_status_enum", create_type=False), default="active"),
        sa.Column("description", sa.Text),
        sa.Column("max_students", sa.Integer, default=30),
        sa.Column("max_internal", sa.Integer, default=30),
        sa.Column("max_external", sa.Integer, default=70),
        sa.Column("semester_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("academic_semesters.id"), nullable=False),
        sa.Column("department_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("departments.id"), nullable=False),
        sa.Column("faculty_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("code", "semester_id", name="uq_course_code_semester"),
    )

    op.create_table("enrollments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("student_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("course_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("courses.id"), nullable=False),
        sa.Column("status", postgresql.ENUM(name="enrollment_status_enum", create_type=False), default="pending"),
        sa.Column("remarks", sa.Text),
        sa.Column("approved_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("student_id", "course_id", name="uq_student_course"),
    )

    op.create_table("grade_sheets",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("course_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("courses.id"), unique=True, nullable=False),
        sa.Column("status", postgresql.ENUM(name="grade_sheet_status_enum", create_type=False), default="draft"),
        sa.Column("submitted_at", sa.DateTime(timezone=True)),
        sa.Column("locked", sa.Boolean, default=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table("grade_entries",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("grade_sheet_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("grade_sheets.id"), nullable=False),
        sa.Column("student_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("internal_marks", sa.Float),
        sa.Column("external_marks", sa.Float),
        sa.Column("grade", postgresql.ENUM(name="grade_enum", create_type=False)),
        sa.Column("grade_point", sa.Float),
        sa.Column("is_absent", sa.Boolean, default=False),
        sa.Column("is_malpractice", sa.Boolean, default=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("grade_sheet_id", "student_id", name="uq_grade_entry"),
    )

    op.create_table("grade_sheet_approvals",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("grade_sheet_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("grade_sheets.id"), nullable=False),
        sa.Column("stage", sa.String(30), nullable=False),
        sa.Column("action", sa.String(20), nullable=False),
        sa.Column("actor_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("remarks", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table("student_results",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("student_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("course_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("courses.id"), nullable=False),
        sa.Column("semester_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("academic_semesters.id"), nullable=False),
        sa.Column("grade", postgresql.ENUM(name="grade_enum", create_type=False), nullable=False),
        sa.Column("grade_point", sa.Float, nullable=False),
        sa.Column("credits", sa.Integer, nullable=False),
        sa.Column("published_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("student_id", "course_id", name="uq_student_result"),
    )

    op.create_table("theses",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("student_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("guide_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("co_guide_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("department_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("departments.id"), nullable=False),
        sa.Column("title", sa.String(500)),
        sa.Column("topic", sa.Text),
        sa.Column("status", postgresql.ENUM(name="thesis_status_enum", create_type=False), default="registered"),
        sa.Column("registration_date", sa.Date),
        sa.Column("proposal_date", sa.Date),
        sa.Column("submission_date", sa.Date),
        sa.Column("defence_date", sa.Date),
        sa.Column("remarks", sa.Text),
        sa.Column("committee_members", postgresql.JSONB, default=list),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table("ppw_records",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("thesis_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("theses.id"), nullable=False),
        sa.Column("semester_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("academic_semesters.id"), nullable=False),
        sa.Column("status", postgresql.ENUM(name="ppw_status_enum", create_type=False), default="pending"),
        sa.Column("progress_report", sa.Text),
        sa.Column("guide_remarks", sa.Text),
        sa.Column("hod_remarks", sa.Text),
        sa.Column("submitted_at", sa.DateTime(timezone=True)),
        sa.Column("approved_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("thesis_id", "semester_id", name="uq_ppw_thesis_semester"),
    )

    op.create_table("academic_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("description", sa.Text),
        sa.Column("event_date", sa.Date, nullable=False),
        sa.Column("end_date", sa.Date),
        sa.Column("event_type", sa.String(40), default="general"),
        sa.Column("semester_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("academic_semesters.id"), nullable=True),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("is_public", sa.Boolean, default=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── eFMS tables ────────────────────────────────────────────────────────────
    op.create_table("efms_files",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("ref_number", sa.String(60), unique=True, nullable=False),
        sa.Column("subject", sa.String(500), nullable=False),
        sa.Column("category", sa.String(80), default="general"),
        sa.Column("status", postgresql.ENUM(name="file_status_enum", create_type=False), default="draft"),
        sa.Column("priority", postgresql.ENUM(name="file_priority_enum", create_type=False), default="normal"),
        sa.Column("due_date", sa.DateTime(timezone=True)),
        sa.Column("is_confidential", sa.Boolean, default=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("department_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("departments.id"), nullable=True),
        sa.Column("current_holder_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table("notesheets",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("efms_files.id"), unique=True, nullable=False),
        sa.Column("content", sa.Text, default=""),
        sa.Column("version", sa.Integer, default=1),
        sa.Column("last_saved_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("is_locked", sa.Boolean, default=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table("notesheet_versions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("notesheet_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("notesheets.id"), nullable=False),
        sa.Column("version", sa.Integer, nullable=False),
        sa.Column("content", sa.Text, nullable=False),
        sa.Column("saved_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table("route_entries",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("efms_files.id"), nullable=False),
        sa.Column("from_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("to_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("action", postgresql.ENUM(name="route_action_enum", create_type=False), nullable=False),
        sa.Column("remarks", sa.Text),
        sa.Column("is_current", sa.Boolean, default=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table("file_attachments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("efms_files.id"), nullable=False),
        sa.Column("original_name", sa.String(255), nullable=False),
        sa.Column("stored_name", sa.String(255), nullable=False),
        sa.Column("file_size", sa.Integer),
        sa.Column("mime_type", sa.String(100)),
        sa.Column("uploaded_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table("dispatch_records",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("file_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("efms_files.id"), unique=True, nullable=False),
        sa.Column("dispatch_no", sa.String(60), unique=True, nullable=False),
        sa.Column("mode", postgresql.ENUM(name="dispatch_mode_enum", create_type=False), default="internal"),
        sa.Column("recipient", sa.String(300)),
        sa.Column("address", sa.Text),
        sa.Column("dispatched_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("dispatched_at", sa.DateTime(timezone=True)),
        sa.Column("tracking_ref", sa.String(100)),
        sa.Column("remarks", sa.Text),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    # ── Indexes ────────────────────────────────────────────────────────────────
    op.create_index("ix_users_email",       "users",       ["email"])
    op.create_index("ix_course_semester",   "courses",     ["semester_id"])
    op.create_index("ix_enrollment_student","enrollments", ["student_id"])
    op.create_index("ix_enrollment_course", "enrollments", ["course_id"])
    op.create_index("ix_gs_status",         "grade_sheets",["status"])
    op.create_index("ix_result_student",    "student_results", ["student_id"])
    op.create_index("ix_thesis_student",    "theses",      ["student_id"])
    op.create_index("ix_efms_file_status",  "efms_files",  ["status"])
    op.create_index("ix_route_file",        "route_entries",["file_id"])


def downgrade() -> None:
    for tbl in [
        "dispatch_records", "file_attachments", "route_entries",
        "notesheet_versions", "notesheets", "efms_files",
        "academic_events", "ppw_records", "theses",
        "student_results", "grade_sheet_approvals", "grade_entries",
        "grade_sheets", "enrollments", "courses", "academic_semesters",
        "audit_logs", "refresh_tokens", "user_roles", "users",
        "departments", "establishments",
    ]:
        op.drop_table(tbl)
    for enum in [
        "dispatch_mode_enum", "route_action_enum", "file_priority_enum",
        "file_status_enum", "ppw_status_enum", "thesis_status_enum",
        "grade_enum", "grade_sheet_status_enum", "enrollment_status_enum",
        "course_status_enum", "course_type_enum", "gender_enum", "system_role",
    ]:
        op.execute(f"DROP TYPE IF EXISTS {enum}")
