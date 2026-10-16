"""FOC (Fixation of Ceiling) module tables.

foc_officers, foc_projects, foc_sheets, foc_lines, foc_movements — see
app/models/foc.py for what each holds and the approval chain.

Revision ID: 0027
Revises: 0026
Create Date: 2026-10-09
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0027"
down_revision: Union[str, None] = "0026"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _ts():
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    ]


def upgrade() -> None:
    op.create_table(
        "foc_officers",
        sa.Column("id", sa.UUID(as_uuid=True), primary_key=True),
        sa.Column("role", sa.String(30), nullable=False),
        sa.Column("user_id", sa.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        *_ts(),
        sa.UniqueConstraint("role", "user_id", name="uq_foc_officer_role_user"),
    )
    op.create_index("uq_foc_officer_fixed_role", "foc_officers", ["role"], unique=True,
                    postgresql_where=sa.text("role <> 'ddo'"))

    op.create_table(
        "foc_projects",
        sa.Column("id", sa.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(300), nullable=False),
        sa.Column("funded_by", sa.String(200)),
        sa.Column("funding_agency", sa.String(200)),
        sa.Column("establishment_id", sa.UUID(as_uuid=True), sa.ForeignKey("establishments.id")),
        sa.Column("department_id", sa.UUID(as_uuid=True), sa.ForeignKey("departments.id")),
        sa.Column("pi_name", sa.String(200)),
        sa.Column("project_type", sa.String(100)),
        sa.Column("bank_account_holder", sa.String(200)),
        sa.Column("bank_name", sa.String(200)),
        sa.Column("bank_account_no", sa.String(60)),
        sa.Column("fund_instrument_no", sa.String(200)),
        sa.Column("fund_received_date", sa.Date()),
        sa.Column("fund_sanction_remittance_no", sa.String(200)),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_by", sa.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        *_ts(),
    )

    op.create_table(
        "foc_sheets",
        sa.Column("id", sa.UUID(as_uuid=True), primary_key=True),
        sa.Column("number", sa.Integer(), sa.Identity(start=1), nullable=False, unique=True),
        sa.Column("project_id", sa.UUID(as_uuid=True), sa.ForeignKey("foc_projects.id"), nullable=False),
        sa.Column("financial_year", sa.String(9), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("incharge_id", sa.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="draft"),
        sa.Column("stage", sa.String(30)),
        sa.Column("holder_id", sa.UUID(as_uuid=True), sa.ForeignKey("users.id")),
        sa.Column("ddo_id", sa.UUID(as_uuid=True), sa.ForeignKey("users.id")),
        sa.Column("certified", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("submitted_at", sa.DateTime(timezone=True)),
        sa.Column("decided_by", sa.UUID(as_uuid=True), sa.ForeignKey("users.id")),
        sa.Column("decided_stage", sa.String(30)),
        sa.Column("decided_at", sa.DateTime(timezone=True)),
        sa.Column("created_by", sa.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        *_ts(),
        sa.UniqueConstraint("project_id", "financial_year", "name", name="uq_foc_sheet_project_year_name"),
    )
    op.create_index("ix_foc_sheets_holder", "foc_sheets", ["holder_id"])
    op.create_index("ix_foc_sheets_incharge", "foc_sheets", ["incharge_id"])

    op.create_table(
        "foc_lines",
        sa.Column("id", sa.UUID(as_uuid=True), primary_key=True),
        sa.Column("sheet_id", sa.UUID(as_uuid=True), sa.ForeignKey("foc_sheets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sl_no", sa.Integer(), nullable=False),
        sa.Column("sub_head", sa.String(300), nullable=False),
        sa.Column("sanctioned_fund", sa.Numeric(16, 2), nullable=False),
        sa.Column("available_fund", sa.Numeric(16, 2), nullable=False),
        sa.Column("amount_required", sa.Numeric(16, 2), nullable=False, server_default="0"),
        sa.Column("sanction_order_no", sa.String(200)),
        sa.Column("purpose", sa.Text()),
        sa.Column("remark", sa.Text()),
        sa.Column("document_original_name", sa.String(255)),
        sa.Column("document_stored_name", sa.String(255)),
        sa.Column("document_size", sa.Integer()),
        sa.Column("document_mime", sa.String(120)),
        *_ts(),
    )
    op.create_index("ix_foc_lines_sheet_id", "foc_lines", ["sheet_id"])

    op.create_table(
        "foc_movements",
        sa.Column("id", sa.UUID(as_uuid=True), primary_key=True),
        sa.Column("sheet_id", sa.UUID(as_uuid=True), sa.ForeignKey("foc_sheets.id", ondelete="CASCADE"), nullable=False),
        sa.Column("action", sa.String(20), nullable=False),
        sa.Column("from_user_id", sa.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("to_user_id", sa.UUID(as_uuid=True), sa.ForeignKey("users.id")),
        sa.Column("from_stage", sa.String(30)),
        sa.Column("to_stage", sa.String(30)),
        sa.Column("remark", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_foc_movements_sheet_id", "foc_movements", ["sheet_id"])


def downgrade() -> None:
    op.drop_index("ix_foc_movements_sheet_id", table_name="foc_movements")
    op.drop_table("foc_movements")
    op.drop_index("ix_foc_lines_sheet_id", table_name="foc_lines")
    op.drop_table("foc_lines")
    op.drop_index("ix_foc_sheets_incharge", table_name="foc_sheets")
    op.drop_index("ix_foc_sheets_holder", table_name="foc_sheets")
    op.drop_table("foc_sheets")
    op.drop_table("foc_projects")
    op.drop_index("uq_foc_officer_fixed_role", table_name="foc_officers")
    op.drop_table("foc_officers")
