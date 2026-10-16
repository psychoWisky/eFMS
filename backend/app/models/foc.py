"""FOC — Fixation of Ceiling.

A separate module inside eFMS (own screens under /foc, own docket) that uses
the same database and the same user accounts.

  Super Admin  sets up FOC projects, creates each FOC sheet (project,
               financial year, name, in-charge) with its budget lines
               (sub head, sanctioned fund, available fund), and assigns the
               approving officers.
  In-charge    fills in each line (amount required, sanction order no,
               sanction document, purpose, remark), certifies, and sends the
               sheet to a DDO of their choice.
  Officers     DDO → Assistant Comptroller → Finance Officer → Vice
               Chancellor. Whoever holds it may approve (final), reject
               (remark required; goes back to the in-charge) or forward it to
               the next officer (the Vice Chancellor cannot forward).

There can be several DDOs; the other three are single, fixed people.
"""
import enum

from sqlalchemy import (
    Boolean, Column, Date, DateTime, ForeignKey, Identity, Index, Integer,
    Numeric, String, Text, UniqueConstraint, text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.db.base import Base, TimestampMixin, UUIDMixin


class FocOfficerRole(str, enum.Enum):
    DDO = "ddo"
    ASSISTANT_COMPTROLLER = "assistant_comptroller"
    FINANCE_OFFICER = "finance_officer"
    VICE_CHANCELLOR = "vice_chancellor"


# Approval chain, in order. Forwarding moves a sheet one step along it.
FOC_CHAIN = [
    FocOfficerRole.DDO,
    FocOfficerRole.ASSISTANT_COMPTROLLER,
    FocOfficerRole.FINANCE_OFFICER,
    FocOfficerRole.VICE_CHANCELLOR,
]
FIXED_ROLES = {r for r in FOC_CHAIN if r != FocOfficerRole.DDO}

ROLE_TITLES = {
    FocOfficerRole.DDO: "DDO",
    FocOfficerRole.ASSISTANT_COMPTROLLER: "Assistant Comptroller",
    FocOfficerRole.FINANCE_OFFICER: "Finance Officer",
    FocOfficerRole.VICE_CHANCELLOR: "Vice Chancellor",
}


class FocStatus(str, enum.Enum):
    DRAFT = "draft"          # with the in-charge, never sent
    PENDING = "pending"      # with an officer (see stage / holder_id)
    APPROVED = "approved"    # final — back with the in-charge, downloadable
    REJECTED = "rejected"    # back with the in-charge for corrections


class FocOfficer(Base, UUIDMixin, TimestampMixin):
    """Who acts as DDO (any number) / Assistant Comptroller / Finance
    Officer / Vice Chancellor (one each) — assigned by the Super Admin."""
    __tablename__ = "foc_officers"

    role = Column(String(30), nullable=False)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    user = relationship("User")

    __table_args__ = (
        UniqueConstraint("role", "user_id", name="uq_foc_officer_role_user"),
        # The three fixed officers are single people.
        Index("uq_foc_officer_fixed_role", "role", unique=True, postgresql_where=text("role <> 'ddo'")),
    )


class FocProject(Base, UUIDMixin, TimestampMixin):
    """Master data for a funded project (what the reference screens show in
    the Project / Bank / Fund boxes)."""
    __tablename__ = "foc_projects"

    name = Column(String(300), nullable=False)
    funded_by = Column(String(200), nullable=True)            # e.g. Govt. of India
    funding_agency = Column(String(200), nullable=True)       # e.g. DBT
    establishment_id = Column(UUID(as_uuid=True), ForeignKey("establishments.id"), nullable=True)
    department_id = Column(UUID(as_uuid=True), ForeignKey("departments.id"), nullable=True)
    pi_name = Column(String(200), nullable=True)              # Project P.I. (text — not an account)
    project_type = Column(String(100), nullable=True)         # e.g. 100%
    bank_account_holder = Column(String(200), nullable=True)
    bank_name = Column(String(200), nullable=True)
    bank_account_no = Column(String(60), nullable=True)
    fund_instrument_no = Column(String(200), nullable=True)
    fund_received_date = Column(Date, nullable=True)
    fund_sanction_remittance_no = Column(String(200), nullable=True)
    is_active = Column(Boolean, nullable=False, default=True, server_default=text("true"))
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)

    establishment = relationship("Establishment")
    department = relationship("Department")


class FocSheet(Base, UUIDMixin, TimestampMixin):
    """One FOC: a project's funding requirement for a financial year."""
    __tablename__ = "foc_sheets"

    # Short running number shown to people (the "ID" column of the docket).
    number = Column(Integer, Identity(start=1), nullable=False, unique=True)
    project_id = Column(UUID(as_uuid=True), ForeignKey("foc_projects.id"), nullable=False)
    financial_year = Column(String(9), nullable=False)       # "2025-2026"
    name = Column(String(200), nullable=False)               # e.g. "October 2025"
    incharge_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)

    status = Column(String(20), nullable=False, default=FocStatus.DRAFT.value, server_default=FocStatus.DRAFT.value)
    stage = Column(String(30), nullable=True)                 # officer role holding it while pending
    holder_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)  # officer holding it while pending
    ddo_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)     # DDO chosen for the current round
    certified = Column(Boolean, nullable=False, default=False, server_default=text("false"))
    submitted_at = Column(DateTime(timezone=True), nullable=True)  # last time the in-charge sent it
    decided_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)  # who approved / rejected last
    decided_stage = Column(String(30), nullable=True)
    decided_at = Column(DateTime(timezone=True), nullable=True)
    created_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)

    project = relationship("FocProject")
    incharge = relationship("User", foreign_keys=[incharge_id])
    holder = relationship("User", foreign_keys=[holder_id])
    lines = relationship("FocLine", back_populates="sheet", cascade="all, delete-orphan", order_by="FocLine.sl_no")
    movements = relationship("FocMovement", back_populates="sheet", cascade="all, delete-orphan", order_by="FocMovement.created_at")

    __table_args__ = (
        UniqueConstraint("project_id", "financial_year", "name", name="uq_foc_sheet_project_year_name"),
        Index("ix_foc_sheets_holder", "holder_id"),
        Index("ix_foc_sheets_incharge", "incharge_id"),
    )


class FocLine(Base, UUIDMixin, TimestampMixin):
    """One budget line (sub head). The Super Admin sets the first four
    columns; the in-charge fills in the rest."""
    __tablename__ = "foc_lines"

    sheet_id = Column(UUID(as_uuid=True), ForeignKey("foc_sheets.id", ondelete="CASCADE"), nullable=False, index=True)
    sl_no = Column(Integer, nullable=False)
    sub_head = Column(String(300), nullable=False)
    sanctioned_fund = Column(Numeric(16, 2), nullable=False, default=0)
    available_fund = Column(Numeric(16, 2), nullable=False, default=0)
    # filled in by the in-charge
    amount_required = Column(Numeric(16, 2), nullable=False, default=0, server_default=text("0"))
    sanction_order_no = Column(String(200), nullable=True)
    purpose = Column(Text, nullable=True)
    remark = Column(Text, nullable=True)
    document_original_name = Column(String(255), nullable=True)
    document_stored_name = Column(String(255), nullable=True)
    document_size = Column(Integer, nullable=True)
    document_mime = Column(String(120), nullable=True)

    sheet = relationship("FocSheet", back_populates="lines")


class FocMovement(Base, UUIDMixin):
    """The trail of a sheet: every send / forward / approve / reject, with
    the remark."""
    __tablename__ = "foc_movements"

    sheet_id = Column(UUID(as_uuid=True), ForeignKey("foc_sheets.id", ondelete="CASCADE"), nullable=False, index=True)
    action = Column(String(20), nullable=False)    # submitted | forwarded | approved | rejected
    from_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    to_user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    from_stage = Column(String(30), nullable=True)  # None = the in-charge
    to_stage = Column(String(30), nullable=True)
    remark = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    sheet = relationship("FocSheet", back_populates="movements")
    from_user = relationship("User", foreign_keys=[from_user_id])
    to_user = relationship("User", foreign_keys=[to_user_id])
