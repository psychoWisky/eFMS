"""Shared fixtures for the eFMS backend test suite.

Runs against the project's own configured database (app.core.config.settings.
DATABASE_URL — the local dev Postgres instance every other backend tool in
this project already targets; there is no separate test database wired up
yet). Every fixture that creates rows tracks them and deletes them in
teardown, so the suite is safe to run repeatedly against a real database and
never leaves rows behind.

Authentication is done by minting real JWTs via app.core.security.
create_access_token — the same primitive app/api/v1/endpoints/auth.py's own
login flow uses internally — rather than exercising the two-step OTP login
endpoints, which need a real mailbox/OTP bypass unavailable in a test run.
"""
import asyncio
import uuid
from typing import AsyncIterator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from sqlalchemy import delete, update

from app.main import app
from app.db.base import AsyncSessionLocal
from app.core.security import create_access_token, hash_password
from app.models.user import User, UserRole, SystemRole, Role


# The async engine (app.db.base.engine) is a module-level singleton whose
# connection pool binds to whichever event loop first uses it. pytest-asyncio
# defaults to a fresh event loop per test function, which breaks that pool on
# the second test ("Event loop is closed"). Sharing one session-scoped loop
# for the whole run keeps every test on the same loop the engine was created on.
@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


def unique_email(prefix: str) -> str:
    return f"pytest.{prefix}.{uuid.uuid4().hex[:10]}@example.test"


@pytest_asyncio.fixture
async def db() -> AsyncIterator[AsyncSession]:
    async with AsyncSessionLocal() as session:
        yield session


@pytest_asyncio.fixture
async def client() -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test/api/v1") as ac:
        yield ac


class UserFactory:
    """Creates real User rows for the duration of a test and deletes them
    (and anything the test attached, via explicit cleanup()) afterward."""

    def __init__(self, db):
        self._db = db
        self._created: list[User] = []

    async def make(
        self,
        role: SystemRole | str,
        *,
        is_active: bool = True,
        first_name: str = "Test",
        last_name: str | None = None,
    ) -> User:
        # active_role is a plain string column (see app/models/user.py) — a
        # SystemRole enum member works here too since it IS a str subclass,
        # but .value must be read explicitly for SystemRole rather than
        # relying on Enum.__str__ (which returns "SystemRole.X", not "x").
        role_name = role.value if isinstance(role, SystemRole) else role
        user = User(
            email=unique_email(role_name),
            hashed_password=hash_password("Pytest@12345"),
            first_name=first_name,
            last_name=last_name or role_name.title(),
            is_active=is_active,
            kyc_completed=True,
            must_change_password=False,
            active_role=role_name,
        )
        self._db.add(user)
        await self._db.flush()
        # require_roles() (app/core/dependencies.py) checks current_user.roles
        # (the UserRole join-table rows), not active_role directly — mirrors
        # _create_user_record's real user-creation path so test users are
        # authorized exactly like admin-created ones.
        self._db.add(UserRole(user_id=user.id, role=role_name))
        await self._db.commit()
        await self._db.refresh(user)
        self._created.append(user)
        return user

    async def cleanup(self) -> None:
        # Raw DELETEs (not ORM db.delete(user)) so SQLAlchemy never needs to
        # load User.audit_logs to decide how to handle it — that relationship
        # hits a pre-existing, unrelated schema-drift issue in this project's
        # audit_logs table that is out of scope for this task.
        ids = [u.id for u in self._created]
        # deactivated_by has no ondelete clause (by design, same convention
        # as every other user-referencing FK) — clear it first so deleting a
        # test Super Admin who deactivated another test user doesn't trip
        # the FK constraint.
        await self._db.execute(update(User).where(User.deactivated_by.in_(ids)).values(deactivated_by=None))
        for user in reversed(self._created):
            await self._db.execute(delete(UserRole).where(UserRole.user_id == user.id))
            await self._db.execute(delete(User).where(User.id == user.id))
        await self._db.commit()


@pytest_asyncio.fixture
async def users(db) -> AsyncIterator[UserFactory]:
    factory = UserFactory(db)
    yield factory
    await factory.cleanup()


class RoleFactory:
    """Creates real Role rows for a test and deletes them afterward."""

    def __init__(self, db):
        self._db = db
        self._created: list[Role] = []

    async def make(self, name: str, description: str | None = None, is_system: bool = False) -> Role:
        role = Role(name=name, description=description, is_system=is_system)
        self._db.add(role)
        await self._db.commit()
        await self._db.refresh(role)
        self._created.append(role)
        return role

    async def cleanup(self) -> None:
        for role in reversed(self._created):
            await self._db.execute(delete(Role).where(Role.id == role.id))
        await self._db.commit()


@pytest_asyncio.fixture
async def roles(db) -> AsyncIterator[RoleFactory]:
    factory = RoleFactory(db)
    yield factory
    await factory.cleanup()


def auth_headers(user: User) -> dict:
    token = create_access_token(
        subject=str(user.id),
        extra_claims={"role": user.active_role if user.active_role else None},
    )
    return {"Authorization": f"Bearer {token}"}
