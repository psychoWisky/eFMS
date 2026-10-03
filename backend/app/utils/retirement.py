"""Retired people: the label that tells them apart.

A person deactivated with the reason "Retired" keeps a limited login (their
Docket only) and can still be sent files. Their role has normally been handed
to someone else, so the role they held comes from history: the roles they
still held when they retired, plus roles handed over to someone else shortly
before (the usual order is: Transfer Ownership, then retire). Several retired
people of one role are told apart by name and retirement date.
"""
from datetime import timedelta
from typing import Iterable

from app.models.user import FormerRoleHolding, SystemRole, User

# Roles handed over this long before the retirement date still describe what
# the person was; older ones are just history of an earlier job.
TRANSFER_WINDOW = timedelta(days=180)


def retired_role_names(user: User, holdings: Iterable[FormerRoleHolding]) -> list[str]:
    """Distinct role names for a retired person, most recent first."""
    cutoff = (user.deactivated_at - TRANSFER_WINDOW) if user.deactivated_at else None
    names: list[str] = []

    def add(name: str) -> None:
        if name != SystemRole.SUPER_ADMIN and name not in names:
            names.append(name)

    for h in sorted(holdings, key=lambda h: h.ended_at, reverse=True):
        if h.reason == "retired" or cutoff is None or h.ended_at >= cutoff:
            add(h.role)
    for ur in user.roles or []:
        add(ur.role)
    return names
