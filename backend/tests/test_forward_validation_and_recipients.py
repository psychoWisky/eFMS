"""Direct Forward (create + forward in one flow), the backend notesheet-
not-empty guard on every forward, and the Super Admin recipient exclusion —
see route_file's forward branch and admin.py's list_users (Parts 5-7 of the
My Files/Direct Forward task).

Direct Forward itself has no new backend endpoint — the frontend just calls
POST /efms/files then POST /{id}/route (action=forward) back to back, reusing
the exact existing endpoints. These tests exercise that same sequence
directly to prove the reused flow behaves correctly end-to-end, and that the
new notesheet/recipient guards apply to it exactly as they do to the
existing draft-then-forward flow.
"""
import pytest
from sqlalchemy import delete as sa_delete, select

from app.models.efms import EfmsFile, Notesheet, DispatchRecord
from app.models.user import SystemRole
from tests.conftest import auth_headers


async def _delete_file(db, file_id):
    await db.execute(sa_delete(DispatchRecord).where(DispatchRecord.file_id == file_id))
    f = await db.get(EfmsFile, file_id)
    if f:
        await db.delete(f)
        await db.commit()


async def _create_file(client, creator, content="Some real notesheet content"):
    r = await client.post(
        "/efms/files",
        json={"subject": "Forward validation test file", "category": "general", "initial_content": content},
        headers=auth_headers(creator),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


# ── 18-21: direct forward (create -> immediately forward) ───────────────────

@pytest.mark.asyncio
async def test_new_file_can_be_forwarded_without_a_separate_save_draft_step(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    recipient = await users.make(SystemRole.EFMS_OFFICER, first_name="Recipient")
    file_id = await _create_file(client, creator, content="Direct forward content")
    try:
        r = await client.post(
            f"/efms/files/{file_id}/route",
            json={"action": "forward", "to_user_id": str(recipient.id)},
            headers=auth_headers(creator),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "active"
        assert body["current_holder_id"] == str(recipient.id)
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_existing_draft_then_forward_flow_still_works(client, users, db):
    """Regression: the original two-step Save Draft -> Forward flow (a
    second, later PATCH/forward, not the immediate one above) must be
    completely unaffected by Direct Forward's addition."""
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    recipient = await users.make(SystemRole.EFMS_OFFICER, first_name="Recipient")
    file_id = await _create_file(client, creator, content="Draft content written first")
    r = await client.patch(
        f"/efms/files/{file_id}/notesheet",
        json={"content": "Draft content written first, then edited"},
        headers=auth_headers(creator),
    )
    assert r.status_code == 200, r.text
    try:
        r = await client.post(
            f"/efms/files/{file_id}/route",
            json={"action": "forward", "to_user_id": str(recipient.id)},
            headers=auth_headers(creator),
        )
        assert r.status_code == 200, r.text
        assert r.json()["current_holder_id"] == str(recipient.id)
    finally:
        await _delete_file(db, file_id)


# ── 22-27: notesheet-not-empty guard on forward ──────────────────────────────

@pytest.mark.asyncio
async def test_forward_rejected_when_notesheet_empty_string(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    recipient = await users.make(SystemRole.EFMS_OFFICER, first_name="Recipient")
    file_id = await _create_file(client, creator, content="")
    try:
        r = await client.post(
            f"/efms/files/{file_id}/route",
            json={"action": "forward", "to_user_id": str(recipient.id)},
            headers=auth_headers(creator),
        )
        assert r.status_code == 400
        assert "notesheet" in r.json()["detail"].lower()
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_forward_rejected_when_notesheet_null(client, users, db):
    """A file with no Notesheet row at all (shouldn't normally happen via
    create_file, but the check must not assume f.notesheet is always set)."""
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    recipient = await users.make(SystemRole.EFMS_OFFICER, first_name="Recipient")
    file_id = await _create_file(client, creator, content="")
    ns = await db.scalar(select(Notesheet).where(Notesheet.file_id == file_id))
    await db.delete(ns)
    await db.commit()
    try:
        r = await client.post(
            f"/efms/files/{file_id}/route",
            json={"action": "forward", "to_user_id": str(recipient.id)},
            headers=auth_headers(creator),
        )
        assert r.status_code == 400
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_forward_rejected_when_notesheet_whitespace_only(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    recipient = await users.make(SystemRole.EFMS_OFFICER, first_name="Recipient")
    file_id = await _create_file(client, creator, content="   \n\t  ")
    try:
        r = await client.post(
            f"/efms/files/{file_id}/route",
            json={"action": "forward", "to_user_id": str(recipient.id)},
            headers=auth_headers(creator),
        )
        assert r.status_code == 400
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_forward_rejected_when_notesheet_empty_html_tags_only(client, users, db):
    """Tiptap's own "empty" output is never a literal empty string —
    "<p></p>" must be recognized as empty too."""
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    recipient = await users.make(SystemRole.EFMS_OFFICER, first_name="Recipient")
    file_id = await _create_file(client, creator, content="<p></p><p><br></p>")
    try:
        r = await client.post(
            f"/efms/files/{file_id}/route",
            json={"action": "forward", "to_user_id": str(recipient.id)},
            headers=auth_headers(creator),
        )
        assert r.status_code == 400
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_forward_allowed_with_real_notesheet_content(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    recipient = await users.make(SystemRole.EFMS_OFFICER, first_name="Recipient")
    file_id = await _create_file(client, creator, content="<p>Real content here.</p>")
    try:
        r = await client.post(
            f"/efms/files/{file_id}/route",
            json={"action": "forward", "to_user_id": str(recipient.id)},
            headers=auth_headers(creator),
        )
        assert r.status_code == 200, r.text
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_direct_api_call_cannot_bypass_notesheet_requirement(client, users, db):
    """Same guard, hit via a bare API call with no client-side validation in
    front of it at all — proves the enforcement is genuinely server-side."""
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    recipient = await users.make(SystemRole.EFMS_OFFICER, first_name="Recipient")
    file_id = await _create_file(client, creator, content="")
    try:
        r = await client.post(
            f"/efms/files/{file_id}/route",
            json={"action": "forward", "to_user_id": str(recipient.id), "remarks": "trying to sneak this through"},
            headers=auth_headers(creator),
        )
        assert r.status_code == 400
        # And the file must NOT have actually moved.
        r2 = await client.get(f"/efms/files/{file_id}", headers=auth_headers(creator))
        assert r2.json()["status"] == "draft"
        assert r2.json()["current_holder_id"] == str(creator.id)
    finally:
        await _delete_file(db, file_id)


# ── 28-30: Super Admin recipient exclusion ───────────────────────────────────

@pytest.mark.asyncio
async def test_super_admin_excluded_from_recipient_list(client, users, db):
    normal = await users.make(SystemRole.EFMS_OFFICER, first_name="Normal")
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="TheSuperAdmin")
    r = await client.get("/admin/users", headers=auth_headers(normal))
    assert r.status_code == 200
    ids = {u["id"] for u in r.json()}
    assert str(super_admin.id) not in ids


@pytest.mark.asyncio
async def test_backend_rejects_direct_forward_to_super_admin(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    super_admin = await users.make(SystemRole.SUPER_ADMIN, first_name="TheSuperAdmin")
    file_id = await _create_file(client, creator, content="<p>Valid content.</p>")
    try:
        r = await client.post(
            f"/efms/files/{file_id}/route",
            json={"action": "forward", "to_user_id": str(super_admin.id)},
            headers=auth_headers(creator),
        )
        assert r.status_code == 400
        assert "super admin" in r.json()["detail"].lower()
        # File must not have moved.
        r2 = await client.get(f"/efms/files/{file_id}", headers=auth_headers(creator))
        assert r2.json()["current_holder_id"] == str(creator.id)
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_valid_recipient_forwarding_unaffected(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    recipient = await users.make(SystemRole.EFMS_OFFICER, first_name="ValidRecipient")
    r = await client.get("/admin/users", headers=auth_headers(creator))
    assert r.status_code == 200
    ids = {u["id"] for u in r.json()}
    assert str(recipient.id) in ids
    file_id = await _create_file(client, creator, content="<p>Valid content.</p>")
    try:
        r = await client.post(
            f"/efms/files/{file_id}/route",
            json={"action": "forward", "to_user_id": str(recipient.id)},
            headers=auth_headers(creator),
        )
        assert r.status_code == 200, r.text
    finally:
        await _delete_file(db, file_id)
