"""Signatures are made with the officer's DSC (USB token) instead of an OTP.

file_signatures gains what is needed to sign a PDF in two steps and to record
who signed with which certificate:
  method        'otp' (earlier signatures, kept as they are) | 'dsc'
  attachment_id the document signed
  prepared_name the prepared PDF waiting for the token's signature (private)
  digest_hex / reserved_start / reserved_end / field_name   the prepared state
  cert_*        certificate details recorded when the signature is added

Revision ID: 0031
Revises: 0030
Create Date: 2026-11-20
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "0031"
down_revision: Union[str, None] = "0030"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("file_signatures", sa.Column("method", sa.String(10), nullable=False, server_default="otp"))
    op.add_column("file_signatures", sa.Column("attachment_id", sa.UUID(as_uuid=True),
                  sa.ForeignKey("file_attachments.id", ondelete="SET NULL"), nullable=True))
    op.add_column("file_signatures", sa.Column("prepared_name", sa.String(80), nullable=True))
    op.add_column("file_signatures", sa.Column("digest_hex", sa.String(64), nullable=True))
    op.add_column("file_signatures", sa.Column("reserved_start", sa.Integer(), nullable=True))
    op.add_column("file_signatures", sa.Column("reserved_end", sa.Integer(), nullable=True))
    op.add_column("file_signatures", sa.Column("field_name", sa.String(40), nullable=True))
    op.add_column("file_signatures", sa.Column("cert_cn", sa.String(255), nullable=True))
    op.add_column("file_signatures", sa.Column("cert_serial", sa.String(80), nullable=True))
    op.add_column("file_signatures", sa.Column("cert_issuer", sa.String(500), nullable=True))
    op.add_column("file_signatures", sa.Column("cert_not_after", sa.DateTime(timezone=True), nullable=True))
    op.add_column("file_signatures", sa.Column("cert_fingerprint", sa.String(64), nullable=True))


def downgrade() -> None:
    for c in ("cert_fingerprint", "cert_not_after", "cert_issuer", "cert_serial", "cert_cn", "field_name",
              "reserved_end", "reserved_start", "digest_hex", "prepared_name", "attachment_id", "method"):
        op.drop_column("file_signatures", c)
