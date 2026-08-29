"""Urgent-file forward email behavior — ordinary users vs. project profiles.

A project profile (User.origin_user_id IS NOT NULL) has a synthetic email
that must never be used as an actual send target (see
app/api/v1/endpoints/projects.py's _build_profile_email). When an urgent
file is forwarded TO a project profile, route_file (efms_files.py) must
still set current_holder_id to the project profile's own users.id (file
routing is unchanged), but the notification EMAIL must go to the profile's
origin_user's real address instead, using wording that clearly identifies
the project-profile identity and project.

_send_email is monkeypatched at the module level (app.api.v1.endpoints.
efms_files._send_email) so these tests observe exactly what route_file
would have sent, without requiring real SMTP configuration.
"""
import pytest
from sqlalchemy import delete as sa_delete, update as sa_update, select

from app.api.v1.endpoints import efms_files as efms_files_module
from app.models.efms import EfmsFile, DispatchRecord
from app.models.project import Project
from app.models.user import User, SystemRole
from tests.conftest import auth_headers


# ── Helpers (mirrors tests/test_project_profiles.py's own) ──────────────────

async def _delete_file(db, file_id):
    await db.execute(sa_delete(DispatchRecord).where(DispatchRecord.file_id == file_id))
    f = await db.get(EfmsFile, file_id)
    if f:
        await db.delete(f)
        await db.commit()


async def _delete_project(db, project_id):
    await db.execute(sa_update(Project).where(Project.id == project_id).values(current_profile_id=None))
    result = await db.execute(select(User.id).where(User.project_id == project_id))
    profile_ids = [row[0] for row in result.all()]
    if profile_ids:
        await db.execute(sa_delete(User).where(User.id.in_(profile_ids)))
    await db.execute(sa_delete(Project).where(Project.id == project_id))
    await db.commit()


async def _create_project(client, super_admin, name="Urgent Email Test Project"):
    r = await client.post("/projects", json={"name": name}, headers=auth_headers(super_admin))
    assert r.status_code == 201, r.text
    return r.json()


async def _assign(client, super_admin, project_id, user_id):
    r = await client.post(f"/projects/{project_id}/assign", json={"user_id": str(user_id)}, headers=auth_headers(super_admin))
    assert r.status_code == 200, r.text
    return r.json()


async def _create_urgent_file(client, creator, subject="Urgent email test file"):
    r = await client.post("/efms/files", json={
        "subject": subject, "category": "general", "priority": "urgent", "initial_content": "<p>content</p>",
    }, headers=auth_headers(creator))
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _capture_sent_emails(monkeypatch):
    sent = []

    def _fake_send_email(to, subject, body):
        sent.append({"to": to, "subject": subject, "body": body})

    monkeypatch.setattr(efms_files_module, "_send_email", _fake_send_email)
    return sent


# ── Ordinary user — existing behavior must be unaffected ────────────────────

@pytest.mark.asyncio
async def test_ordinary_user_urgent_email_goes_to_own_email(client, users, db, monkeypatch):
    sent = _capture_sent_emails(monkeypatch)
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    recipient = await users.make(SystemRole.EFMS_OFFICER, first_name="Recipient")
    file_id = await _create_urgent_file(client, creator)
    try:
        r = await client.post(f"/efms/files/{file_id}/route", json={"action": "forward", "to_user_id": str(recipient.id)}, headers=auth_headers(creator))
        assert r.status_code == 200, r.text

        assert len(sent) == 1
        assert sent[0]["to"] == recipient.email
        assert "File forwarded to you" in sent[0]["subject"]
        assert recipient.full_name in sent[0]["body"]
        assert "AVFU eFMS" in sent[0]["body"]
        assert "AAU" not in sent[0]["subject"] and "AAU" not in sent[0]["body"]
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_non_urgent_file_still_sends_no_email(client, users, db, monkeypatch):
    """Regression: this fix must not change the existing urgent-only rule."""
    sent = _capture_sent_emails(monkeypatch)
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    recipient = await users.make(SystemRole.EFMS_OFFICER, first_name="Recipient")
    r = await client.post("/efms/files", json={
        "subject": "Normal priority file", "category": "general", "priority": "normal", "initial_content": "<p>content</p>",
    }, headers=auth_headers(creator))
    file_id = r.json()["id"]
    try:
        r = await client.post(f"/efms/files/{file_id}/route", json={"action": "forward", "to_user_id": str(recipient.id)}, headers=auth_headers(creator))
        assert r.status_code == 200
        assert sent == []
    finally:
        await _delete_file(db, file_id)


# ── Project profile recipient — the core fix ─────────────────────────────────

@pytest.mark.asyncio
async def test_project_profile_urgent_email_goes_to_origin_users_real_email(client, users, db, monkeypatch):
    sent = _capture_sent_emails(monkeypatch)
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA", last_name="Original")
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    project = await _create_project(client, super_admin)
    file_id = None
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        profile = await db.get(User, result["current_profile_id"])

        file_id = await _create_urgent_file(client, creator)
        r = await client.post(f"/efms/files/{file_id}/route", json={"action": "forward", "to_user_id": str(profile.id)}, headers=auth_headers(creator))
        assert r.status_code == 200, r.text

        # File routing itself is unchanged: current_holder_id is the
        # PROJECT PROFILE's own id, never the origin's.
        assert r.json()["current_holder_id"] == str(profile.id)

        # The email, however, must go to the ORIGIN's real address —
        # never the profile's synthetic one.
        assert len(sent) == 1
        assert sent[0]["to"] == origin.email
        assert sent[0]["to"] != profile.email
        assert "+pi" not in sent[0]["to"]
    finally:
        if file_id:
            await _delete_file(db, file_id)
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_project_profile_urgent_email_identifies_the_profile_and_project(client, users, db, monkeypatch):
    sent = _capture_sent_emails(monkeypatch)
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA", last_name="Original")
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    project = await _create_project(client, super_admin, name="ABC Research Project")
    file_id = None
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        profile_name = result["current_profile_name"]  # e.g. "UserA Original PI<number>"

        file_id = await _create_urgent_file(client, creator)
        await client.post(f"/efms/files/{file_id}/route", json={"action": "forward", "to_user_id": result["current_profile_id"]}, headers=auth_headers(creator))

        assert len(sent) == 1
        # Clearly identifies the project-profile identity, not just the person.
        assert profile_name in sent[0]["subject"] or profile_name in sent[0]["body"]
        assert profile_name in sent[0]["body"]
        # Project number/name present where available.
        assert project["project_number"] in sent[0]["body"]
        assert project["name"] in sent[0]["body"]
        # Still addressed to the real person by name (the actual mailbox owner).
        assert origin.full_name in sent[0]["body"]
        assert "AVFU eFMS" in sent[0]["body"]
        assert "AAU" not in sent[0]["subject"] and "AAU" not in sent[0]["body"]
    finally:
        if file_id:
            await _delete_file(db, file_id)
        await _delete_project(db, project["id"])


@pytest.mark.asyncio
async def test_project_profile_synthetic_email_never_used_as_destination(client, users, db, monkeypatch):
    sent = _capture_sent_emails(monkeypatch)
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="Admin")
    origin = await users.make(SystemRole.EFMS_OFFICER, first_name="UserA")
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    project = await _create_project(client, super_admin)
    file_id = None
    try:
        result = await _assign(client, super_admin, project["id"], origin.id)
        profile = await db.get(User, result["current_profile_id"])
        assert "+pi" in profile.email  # sanity check on the synthetic address itself

        file_id = await _create_urgent_file(client, creator)
        await client.post(f"/efms/files/{file_id}/route", json={"action": "forward", "to_user_id": str(profile.id)}, headers=auth_headers(creator))

        all_destinations = [m["to"] for m in sent]
        assert profile.email not in all_destinations
    finally:
        if file_id:
            await _delete_file(db, file_id)
        await _delete_project(db, project["id"])
