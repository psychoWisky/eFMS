"""Project-specific user profiles (PI profiles) — Super-Admin project CRUD/
assignment, profile switching, recipient-list visibility, project
completion/reactivation/reassignment, and — most importantly — that a
project profile's files are fully isolated from its origin person's
original profile and from any sibling project profile, using exactly the
SAME unmodified authorization helpers (efms_files.py/docket.py) already
covered by test_my_files_restricted_access.py and
test_authorization_and_lifecycle.py. A project profile is deliberately
"just another users.id" to that code — these tests prove that holds.
"""
import pytest
from sqlalchemy import delete as sa_delete, update as sa_update, select

from app.models.efms import EfmsFile, DispatchRecord
from app.models.project import Project
from app.models.user import User, SystemRole
from tests.conftest import auth_headers


# ── Cleanup helpers ───────────────────────────────────────────────────────────

async def _delete_file(db, file_id):
    await db.execute(sa_delete(DispatchRecord).where(DispatchRecord.file_id == file_id))
    f = await db.get(EfmsFile, file_id)
    if f:
        await db.delete(f)
        await db.commit()


async def _delete_project(db, project_id):
    # Null out current_profile_id first (Project -> profile FK), delete any
    # profile rows for this project, then the project row itself. Raw SQL
    # DELETEs (not ORM db.delete()) — same reason UserFactory.cleanup() in
    # conftest.py uses raw deletes: db.delete() would load User.audit_logs
    # to decide how to null its FK, which hits a pre-existing, unrelated
    # schema-drift issue in this project's audit_logs table (out of scope
    # here, already documented in conftest.py).
    await db.execute(sa_update(Project).where(Project.id == project_id).values(current_profile_id=None))
    result = await db.execute(select(User.id).where(User.project_id == project_id))
    profile_ids = [row[0] for row in result.all()]
    if profile_ids:
        await db.execute(sa_delete(User).where(User.id.in_(profile_ids)))
    await db.execute(sa_delete(Project).where(Project.id == project_id))
    await db.commit()


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _create_project(client, super_admin, name="Test Project"):
    r = await client.post("/projects", json={"name": name, "funding_agency": "ICAR", "total_funding": 100000}, headers=auth_headers(super_admin))
    assert r.status_code == 201, r.text
    return r.json()

async def _assign(client, super_admin, project_id, user_id):
    r = await client.post(f"/projects/{project_id}/assign", json={"user_id": str(user_id)}, headers=auth_headers(super_admin))
    assert r.status_code == 200, r.text
    return r.json()

async def _switch(client, token_headers, profile_user_id):
    return await client.post("/auth/switch-profile", json={"profile_user_id": str(profile_user_id)}, headers=token_headers)


# ── Project creation ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_create_project_generates_unique_number(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    p1 = await _create_project(client, super_admin, name="Project One")
    p2 = await _create_project(client, super_admin, name="Project Two")
    try:
        assert p1["project_number"] != p2["project_number"]
        assert p1["status"] == "active"
        assert p1["current_profile_id"] is None
    finally:
        await _delete_project(db, p1["id"])
        await _delete_project(db, p2["id"])


@pytest.mark.asyncio
async def test_non_super_admin_cannot_create_project(client, users, db):
    officer = await users.make(SystemRole.EFMS_OFFICER, first_name="Officer")
    r = await client.post("/projects", json={"name": "x"}, headers=auth_headers(officer))
    assert r.status_code == 403


# ── Project number generation (Postgres sequence, not count()+1) ────────────

@pytest.mark.asyncio
async def test_project_number_is_automatically_generated(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    p = await _create_project(client, super_admin, name="Auto Numbered")
    try:
        assert p["project_number"]
        assert p["project_number"].isdigit()  # plain incrementing integer string, unchanged format
    finally:
        await _delete_project(db, p["id"])


@pytest.mark.asyncio
async def test_sequential_project_creation_produces_distinct_increasing_numbers(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    created = [await _create_project(client, super_admin, name=f"Sequential {i}") for i in range(5)]
    try:
        numbers = [int(p["project_number"]) for p in created]
        assert len(numbers) == len(set(numbers))  # all unique
        assert numbers == sorted(numbers)  # sequence only ever increases
    finally:
        for p in created:
            await _delete_project(db, p["id"])


@pytest.mark.asyncio
async def test_concurrent_project_creation_never_collides(client, users, db):
    """The actual regression test for the count()+1 race: fire many
    POST /projects calls concurrently (interleaved on the shared event loop,
    each hitting the database independently via nextval()) and confirm
    every resulting project_number is unique and every request succeeds —
    the old count()+1 approach could produce a duplicate under exactly this
    kind of overlap and raise an unhandled IntegrityError on the loser."""
    import asyncio

    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    results = await asyncio.gather(*[
        _create_project(client, super_admin, name=f"Concurrent {i}") for i in range(10)
    ])
    try:
        numbers = [r["project_number"] for r in results]
        assert len(numbers) == 10
        assert len(numbers) == len(set(numbers))  # no duplicate numbers under concurrency
    finally:
        for r in results:
            await _delete_project(db, r["id"])


# ── Assignment ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_assign_creates_project_profile(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA", last_name="Original")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        assert result["current_profile_id"] is not None
        assert result["current_profile_name"] == f"UserA Original PI{project['project_number']}"

        profile = await db.get(User, result["current_profile_id"])
        assert profile.origin_user_id == origin.id
        assert str(profile.project_id) == project["id"]
        assert profile.is_active is True
        assert profile.hashed_password is None
        assert profile.active_role == origin.active_role
        assert profile.department_id == origin.department_id
        assert profile.designation == origin.designation
    finally:
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_cannot_assign_super_admin(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    another_super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin2")
    project = await _create_project(client, super_admin)
    try:
        r = await client.post(f"/projects/{project['id']}/assign", json={"user_id": str(another_super_admin.id)}, headers=auth_headers(super_admin))
        assert r.status_code == 400
    finally:
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_cannot_assign_already_a_project_profile(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        other_project = await _create_project(client, super_admin, name="Other")
        try:
            r = await client.post(
                f"/projects/{other_project['id']}/assign",
                json={"user_id": result["current_profile_id"]},
                headers=auth_headers(super_admin),
            )
            assert r.status_code == 400
        finally:
            await _delete_project(db, other_project["id"])
    finally:
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_cannot_assign_twice_without_reassign(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    origin2 = await users.make(SystemRole.EFMS_OFFICER, first_name="UserE")
    project = await _create_project(client, super_admin)
    try:
        await _assign(client, super_admin, project["id"], origin.id)
        r = await client.post(f"/projects/{project['id']}/assign", json={"user_id": str(origin2.id)}, headers=auth_headers(super_admin))
        assert r.status_code == 400
    finally:
        await _delete_project(db, project["id"])


# ── Profile switching ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_switch_to_own_project_profile_succeeds(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        r = await _switch(client, auth_headers(origin), result["current_profile_id"])
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["user"]["id"] == result["current_profile_id"]
        assert body["user"]["full_name"] == result["current_profile_name"]
        assert "access_token" in body and "refresh_token" in body
    finally:
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_switch_back_to_original_from_project_profile(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        switched = await _switch(client, auth_headers(origin), result["current_profile_id"])
        profile_headers = {"Authorization": f"Bearer {switched.json()['access_token']}"}
        r = await _switch(client, profile_headers, origin.id)
        assert r.status_code == 200
        assert r.json()["user"]["id"] == str(origin.id)
    finally:
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_cannot_switch_to_someone_elses_project_profile(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    outsider = await users.make(SystemRole.EFMS_OFFICER, first_name="Outsider")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        r = await _switch(client, auth_headers(outsider), result["current_profile_id"])
        assert r.status_code == 403
    finally:
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_cannot_switch_to_inactive_project_profile(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        r = await client.patch(f"/projects/{project['id']}/complete", headers=auth_headers(super_admin))
        assert r.status_code == 200
        r = await _switch(client, auth_headers(origin), result["current_profile_id"])
        assert r.status_code == 403
    finally:
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_project_profile_has_no_password_login(client, users, db):
    """Even with the (nonexistent) password, direct login must be
    impossible — hashed_password is NULL, so /login/step1 always rejects."""
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        profile = await db.get(User, result["current_profile_id"])
        r = await client.post("/auth/login/step1", json={"email": profile.email, "password": "anything"})
        assert r.status_code == 401
    finally:
        await _delete_project(db, project["id"])


# ── Project completion / reactivation ────────────────────────────────────────

@pytest.mark.asyncio
async def test_complete_project_deactivates_profile_not_origin(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        r = await client.patch(f"/projects/{project['id']}/complete", headers=auth_headers(super_admin))
        assert r.status_code == 200
        assert r.json()["status"] == "completed"

        await db.refresh(origin)
        profile = await db.get(User, result["current_profile_id"])
        assert profile.is_active is False
        assert profile.deactivation_reason_type is None  # person-deactivation metadata untouched
        assert origin.is_active is True
    finally:
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_reactivate_project_restores_switching(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        await client.patch(f"/projects/{project['id']}/complete", headers=auth_headers(super_admin))
        r = await client.patch(f"/projects/{project['id']}/reactivate", headers=auth_headers(super_admin))
        assert r.status_code == 200
        assert r.json()["status"] == "active"

        r = await _switch(client, auth_headers(origin), result["current_profile_id"])
        assert r.status_code == 200
    finally:
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_completed_profile_excluded_from_recipient_list(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    other = await users.make(SystemRole.EFMS_OFFICER, first_name="Other")
    project = await _create_project(client, super_admin)
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        r = await client.get("/admin/users", headers=auth_headers(other))
        ids = {u["id"] for u in r.json()}
        assert result["current_profile_id"] in ids
        badge = next(u for u in r.json() if u["id"] == result["current_profile_id"])
        assert badge["is_project_profile"] is True
        assert badge["project_number"] == project["project_number"]

        await client.patch(f"/projects/{project['id']}/complete", headers=auth_headers(super_admin))
        r = await client.get("/admin/users", headers=auth_headers(other))
        ids = {u["id"] for u in r.json()}
        assert result["current_profile_id"] not in ids
    finally:
        await _delete_project(db, project["id"])


# ── Reassignment ──────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_reassign_deactivates_old_profile_and_creates_new_one(client, users, db):
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin_a = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    origin_d = await users.make(SystemRole.EFMS_OFFICER, first_name="UserD")
    project = await _create_project(client, super_admin)
    try:
        first = await _assign(client, super_admin, project["id"], origin_a.id)
        r = await client.post(f"/projects/{project['id']}/reassign", json={"user_id": str(origin_d.id)}, headers=auth_headers(super_admin))
        assert r.status_code == 200
        second = r.json()
        assert second["current_profile_id"] != first["current_profile_id"]

        old_profile = await db.get(User, first["current_profile_id"])
        assert old_profile.is_active is False
        assert old_profile.origin_user_id == origin_a.id  # never mutated to point at origin_d

        # Old profile can no longer be switched into, even by its original owner.
        r = await _switch(client, auth_headers(origin_a), first["current_profile_id"])
        assert r.status_code == 403
        # New profile belongs to the new person.
        r = await _switch(client, auth_headers(origin_d), second["current_profile_id"])
        assert r.status_code == 200
    finally:
        await _delete_project(db, project["id"])


# ── File isolation (the core requirement) ────────────────────────────────────

@pytest.mark.asyncio
async def test_project_profile_file_isolated_from_origins_original_profile(client, users, db):
    """User A PI74 creates a file; User A's ORIGINAL profile must not see
    it in My Files, and must not be able to open it."""
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    project = await _create_project(client, super_admin)
    file_id = None
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        switched = await _switch(client, auth_headers(origin), result["current_profile_id"])
        profile_headers = {"Authorization": f"Bearer {switched.json()['access_token']}"}

        r = await client.post(
            "/efms/files",
            json={"subject": "PI74 project file", "category": "general", "initial_content": "PI74 content"},
            headers=profile_headers,
        )
        assert r.status_code == 201, r.text
        file_id = r.json()["id"]

        # Original profile's My Files must NOT include this file.
        r = await client.get("/efms/files?outbox=true", headers=auth_headers(origin))
        assert file_id not in {f["id"] for f in r.json()}

        # Original profile cannot open it directly either.
        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(origin))
        assert r.status_code == 403

        # The project profile itself sees it in its own My Files, full access.
        r = await client.get("/efms/files?outbox=true", headers=profile_headers)
        assert file_id in {f["id"] for f in r.json()}
        r = await client.get(f"/efms/files/{file_id}", headers=profile_headers)
        assert r.status_code == 200
        assert r.json()["access_level"] == "full"
    finally:
        if file_id:
            await _delete_file(db, file_id)
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_two_project_profiles_of_same_person_are_isolated(client, users, db):
    """User A PI74 and User A PI81 must not see each other's files."""
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    project74 = await _create_project(client, super_admin, name="Project 74")
    project81 = await _create_project(client, super_admin, name="Project 81")
    file_id = None
    try:
        pi74 = await _assign(client, super_admin, project74["id"], origin.id)
        pi81 = await _assign(client, super_admin, project81["id"], origin.id)

        switched74 = await _switch(client, auth_headers(origin), pi74["current_profile_id"])
        headers74 = {"Authorization": f"Bearer {switched74.json()['access_token']}"}
        switched81 = await _switch(client, auth_headers(origin), pi81["current_profile_id"])
        headers81 = {"Authorization": f"Bearer {switched81.json()['access_token']}"}

        r = await client.post(
            "/efms/files",
            json={"subject": "PI74-only file", "category": "general", "initial_content": "content"},
            headers=headers74,
        )
        assert r.status_code == 201
        file_id = r.json()["id"]

        r = await client.get("/efms/files?outbox=true", headers=headers81)
        assert file_id not in {f["id"] for f in r.json()}
        r = await client.get(f"/efms/files/{file_id}", headers=headers81)
        assert r.status_code == 403
    finally:
        if file_id:
            await _delete_file(db, file_id)
        await _delete_project(db, project74["id"])
        await _delete_project(db, project81["id"])


@pytest.mark.asyncio
async def test_project_profile_forward_preserves_identity_in_routing(client, users, db):
    """PI74 -> B: the RouteEntry/tracking must identify PI74 as sender, not
    User A's original profile — this already falls out of route_entries
    storing whichever users.id acted, unchanged by this feature."""
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    b = await users.make(SystemRole.EFMS_OFFICER, first_name="UserB")
    project = await _create_project(client, super_admin)
    file_id = None
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        switched = await _switch(client, auth_headers(origin), result["current_profile_id"])
        profile_headers = {"Authorization": f"Bearer {switched.json()['access_token']}"}

        r = await client.post(
            "/efms/files",
            json={"subject": "Routing identity test", "category": "general", "initial_content": "content"},
            headers=profile_headers,
        )
        file_id = r.json()["id"]
        r = await client.post(
            f"/efms/files/{file_id}/route",
            json={"action": "forward", "to_user_id": str(b.id)},
            headers=profile_headers,
        )
        assert r.status_code == 200, r.text

        # B sees PI74 (not User A) as the sender.
        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(b))
        assert r.status_code == 200
        body = r.json()
        assert body["creator_info"]["id"] == result["current_profile_id"]
        assert body["creator_info"]["full_name"] == result["current_profile_name"]
        assert body["route_entries"][0]["from_user_id"] == result["current_profile_id"]

        # The PI74 creator, now forwarded away, gets the SAME restricted
        # creator view as any other user — no code change needed for this.
        r = await client.get(f"/efms/files/{file_id}", headers=profile_headers)
        assert r.json()["access_level"] == "creator_restricted"

        # Original User A profile still has no relationship to this file at all.
        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(origin))
        assert r.status_code == 403
    finally:
        if file_id:
            await _delete_file(db, file_id)
        await _delete_project(db, project["id"])
