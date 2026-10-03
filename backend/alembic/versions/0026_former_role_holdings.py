"""History of roles a person used to hold (for "Retired" labels).

When a person retires, their role usually moves to someone else (Transfer
Ownership) — the role row is removed from them, so afterwards nothing says
"this retired person was the Registrar". This table remembers it: one row per
role a person stopped holding, written when the role is handed over or when
the person is retired. It is only used to label retired people in the
recipient list and Users screen ("Name — Registrar (Retired 12 Mar 2026)"),
which is also how several retired people of one role are told apart. It never
grants any access.

Revision ID: 0026
Revises: 0025
Create Date: 2026-10-05
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0026"
down_revision: Union[str, None] = "0025"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "former_role_holdings",
        sa.Column("id", sa.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", sa.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.String(50), nullable=False),
        # SET NULL: this is only history for labels — it must never stop an
        # establishment or department from being deleted.
        sa.Column("establishment_id", sa.UUID(as_uuid=True), sa.ForeignKey("establishments.id", ondelete="SET NULL"), nullable=True),
        sa.Column("department_id", sa.UUID(as_uuid=True), sa.ForeignKey("departments.id", ondelete="SET NULL"), nullable=True),
        sa.Column("reason", sa.String(20), nullable=False),  # "transferred" | "retired"
        sa.Column("ended_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_former_role_holdings_user_id", "former_role_holdings", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_former_role_holdings_user_id", table_name="former_role_holdings")
    op.drop_table("former_role_holdings")
