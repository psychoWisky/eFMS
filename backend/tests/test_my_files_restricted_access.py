"""My Files restricted creator access (Part 1-3, 8 of the My Files/Direct
Forward task): a file's creator, once no longer its current holder, can
still open the file read-only via GET /efms/files/{id} (access_level
"creator_restricted" instead of a 403), read their own original Notesheet
and their own HolderNote holding period(s), but not another holder's
HolderNote content; can still see/preview their own attachments but not
download them (individually or via Download All); and automatically
regains full access if the file is forwarded back to them. A past holder
who is NOT the creator gets none of this — existing behavior, unchanged.

Also covers the My Files "Current Holder" column data (list_files?outbox=true
now populates current_holder_info).
"""
import io

import pytest

from app.models.efms import EfmsFile, DispatchRecord
from app.models.user import SystemRole
from sqlalchemy import delete as sa_delete
from tests.conftest import auth_headers


async def _delete_file(db, file_id):
    await db.execute(sa_delete(DispatchRecord).where(DispatchRecord.file_id == file_id))
    f = await db.get(EfmsFile, file_id)
    if f:
        await db.delete(f)
        await db.commit()


async def _create_file(client, creator, subject="Restricted access test file", content="Original notesheet content"):
    r = await client.post(
        "/efms/files",
        json={"subject": subject, "category": "general", "initial_content": content},
        headers=auth_headers(creator),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _forward(client, sender, recipient, file_id):
    r = await client.post(
        f"/efms/files/{file_id}/route",
        json={"action": "forward", "to_user_id": str(recipient.id)},
        headers=auth_headers(sender),
    )
    assert r.status_code == 200, r.text
    return r.json()


async def _upload_attachment(client, uploader, file_id, filename="doc.pdf"):
    r = await client.post(
        f"/efms/files/{file_id}/attachments",
        files={"upload": (filename, b"%PDF-1.4 fake content", "application/pdf")},
        headers=auth_headers(uploader),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


# ── 1-2: current holder full access, including the creator-still-holder case ──

@pytest.mark.asyncio
async def test_creator_still_current_holder_gets_full_access(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    file_id = await _create_file(client, creator)
    try:
        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(creator))
        assert r.status_code == 200
        assert r.json()["access_level"] == "full"
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_creator_after_forwarding_gets_restricted_access(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    other = await users.make(SystemRole.EFMS_OFFICER, first_name="Other")
    file_id = await _create_file(client, creator)
    await _forward(client, creator, other, file_id)
    try:
        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(creator))
        assert r.status_code == 200
        assert r.json()["access_level"] == "creator_restricted"
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_creator_can_read_own_original_notesheet_while_restricted(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    other = await users.make(SystemRole.EFMS_OFFICER, first_name="Other")
    file_id = await _create_file(client, creator, content="My original document text")
    await _forward(client, creator, other, file_id)
    try:
        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(creator))
        assert r.status_code == 200
        assert r.json()["notesheet"]["content"] == "My original document text"
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_returned_to_creator_regains_full_access(client, users, db):
    """Creator -> Other -> back to Creator: current state must govern, not
    "was this user ever a non-holder" history."""
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    other = await users.make(SystemRole.EFMS_OFFICER, first_name="Other")
    file_id = await _create_file(client, creator)
    await _forward(client, creator, other, file_id)
    # confirm restricted mid-flight
    r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(creator))
    assert r.json()["access_level"] == "creator_restricted"
    await _forward(client, other, creator, file_id)
    try:
        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(creator))
        assert r.status_code == 200
        assert r.json()["access_level"] == "full"
        assert r.json()["current_holder_id"] == str(creator.id)
    finally:
        await _delete_file(db, file_id)


# ── 3-6: HolderNote (own history vs. other holders') ─────────────────────────

@pytest.mark.asyncio
async def test_creator_can_read_own_historical_holder_note(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    other = await users.make(SystemRole.EFMS_OFFICER, first_name="Other")
    file_id = await _create_file(client, creator)
    # Creator writes their own HolderNote before forwarding (they're the
    # current holder of their own Draft up to that point).
    r = await client.patch(
        f"/efms/files/{file_id}/holder-notesheet",
        json={"content": "Creator's own remark"},
        headers=auth_headers(creator),
    )
    assert r.status_code == 200, r.text
    await _forward(client, creator, other, file_id)
    await client.patch(
        f"/efms/files/{file_id}/holder-notesheet",
        json={"content": "Other's private remark"},
        headers=auth_headers(other),
    )
    try:
        r = await client.get(f"/efms/files/{file_id}/holder-notesheets", headers=auth_headers(creator))
        assert r.status_code == 200
        rows = {row["user_id"]: row for row in r.json()}
        own = rows[str(creator.id)]
        assert own["accessible"] is True
        assert own["content"] == "Creator's own remark"
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_creator_cannot_read_other_holders_note_content(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    other = await users.make(SystemRole.EFMS_OFFICER, first_name="Other")
    file_id = await _create_file(client, creator)
    await _forward(client, creator, other, file_id)
    await client.patch(
        f"/efms/files/{file_id}/holder-notesheet",
        json={"content": "Other's private remark"},
        headers=auth_headers(other),
    )
    try:
        r = await client.get(f"/efms/files/{file_id}/holder-notesheets", headers=auth_headers(creator))
        assert r.status_code == 200
        rows = {row["user_id"]: row for row in r.json()}
        others_row = rows[str(other.id)]
        # The row (and who it belongs to) is visible — matching Tracking
        # History's "show the timeline, withhold the text" pattern — but
        # the actual content must never leak to the restricted creator.
        assert others_row["accessible"] is False
        assert others_row["content"] == ""
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_current_holder_sees_every_holder_note_unrestricted(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    other = await users.make(SystemRole.EFMS_OFFICER, first_name="Other")
    file_id = await _create_file(client, creator)
    await _forward(client, creator, other, file_id)
    await client.patch(
        f"/efms/files/{file_id}/holder-notesheet",
        json={"content": "Other's remark, fully visible to self"},
        headers=auth_headers(other),
    )
    try:
        r = await client.get(f"/efms/files/{file_id}/holder-notesheets", headers=auth_headers(other))
        assert r.status_code == 200
        rows = {row["user_id"]: row for row in r.json()}
        assert rows[str(other.id)]["accessible"] is True
        assert rows[str(other.id)]["content"] == "Other's remark, fully visible to self"
    finally:
        await _delete_file(db, file_id)


# ── 7-11: attachments ─────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_creator_can_view_own_attachment_while_restricted(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    other = await users.make(SystemRole.EFMS_OFFICER, first_name="Other")
    file_id = await _create_file(client, creator)
    att_id = await _upload_attachment(client, creator, file_id)
    await _forward(client, creator, other, file_id)
    try:
        r = await client.get(f"/efms/files/{file_id}/attachments/{att_id}/view", headers=auth_headers(creator))
        assert r.status_code == 200
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_creator_cannot_download_own_attachment_while_restricted(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    other = await users.make(SystemRole.EFMS_OFFICER, first_name="Other")
    file_id = await _create_file(client, creator)
    att_id = await _upload_attachment(client, creator, file_id)
    await _forward(client, creator, other, file_id)
    try:
        r = await client.get(f"/efms/files/{file_id}/attachments/{att_id}/download", headers=auth_headers(creator))
        assert r.status_code == 403
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_download_all_excludes_restricted_creators_own_attachments(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    other = await users.make(SystemRole.EFMS_OFFICER, first_name="Other")
    file_id = await _create_file(client, creator)
    await _upload_attachment(client, creator, file_id)
    await _forward(client, creator, other, file_id)
    try:
        # Every attachment on the file was uploaded by the now-restricted
        # creator, so Download All must have nothing left to offer them.
        r = await client.get(f"/efms/files/{file_id}/attachments/zip", headers=auth_headers(creator))
        assert r.status_code == 404
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_creator_cannot_access_other_holders_attachment(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    other = await users.make(SystemRole.EFMS_OFFICER, first_name="Other")
    file_id = await _create_file(client, creator)
    await _forward(client, creator, other, file_id)
    other_att_id = await _upload_attachment(client, other, file_id, filename="others-doc.pdf")
    try:
        r = await client.get(f"/efms/files/{file_id}/attachments/{other_att_id}/view", headers=auth_headers(creator))
        assert r.status_code == 403
        r = await client.get(f"/efms/files/{file_id}/attachments/{other_att_id}/download", headers=auth_headers(creator))
        assert r.status_code == 403
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_current_holder_can_still_download_and_download_all(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    other = await users.make(SystemRole.EFMS_OFFICER, first_name="Other")
    file_id = await _create_file(client, creator)
    att_id = await _upload_attachment(client, creator, file_id)
    await _forward(client, creator, other, file_id)
    try:
        r = await client.get(f"/efms/files/{file_id}/attachments/{att_id}/download", headers=auth_headers(other))
        assert r.status_code == 200
        r = await client.get(f"/efms/files/{file_id}/attachments/zip", headers=auth_headers(other))
        assert r.status_code == 200
    finally:
        await _delete_file(db, file_id)


# ── 12: non-creator past holder stays denied ─────────────────────────────────

@pytest.mark.asyncio
async def test_non_creator_past_holder_still_denied(client, users, db):
    """A -> B -> C. B (not the creator, no longer current holder) must not
    get the new creator-only carve-out — existing behavior, unchanged."""
    a = await users.make(SystemRole.EFMS_OFFICER, first_name="A")
    b = await users.make(SystemRole.EFMS_OFFICER, first_name="B")
    c = await users.make(SystemRole.EFMS_OFFICER, first_name="C")
    file_id = await _create_file(client, a)
    await _forward(client, a, b, file_id)
    await _forward(client, b, c, file_id)
    try:
        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(b))
        assert r.status_code == 403
        r = await client.get(f"/efms/files/{file_id}/holder-notesheets", headers=auth_headers(b))
        assert r.status_code == 403
    finally:
        await _delete_file(db, file_id)


# ── 13-14: covered above (test_returned_to_creator_regains_full_access,
#           test_current_holder_sees_every_holder_note_unrestricted) ────────


# ── 15-17: My Files Current Holder column ────────────────────────────────────

@pytest.mark.asyncio
async def test_my_files_outbox_returns_current_holder_info(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    other = await users.make(SystemRole.EFMS_OFFICER, first_name="Other", last_name="Holder")
    file_id = await _create_file(client, creator)
    await _forward(client, creator, other, file_id)
    try:
        r = await client.get("/efms/files?outbox=true", headers=auth_headers(creator))
        assert r.status_code == 200
        row = next(f for f in r.json() if f["id"] == file_id)
        assert row["current_holder_id"] == str(other.id)
        assert row["current_holder_info"] is not None
        assert row["current_holder_info"]["id"] == str(other.id)
        assert "Other" in row["current_holder_info"]["full_name"]
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_my_files_outbox_handles_missing_holder_safely(client, users, db):
    """A never-forwarded Draft is its own current holder — still must not
    error or return a null id/info pair inconsistently."""
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    file_id = await _create_file(client, creator)
    try:
        r = await client.get("/efms/files?outbox=true", headers=auth_headers(creator))
        assert r.status_code == 200
        row = next(f for f in r.json() if f["id"] == file_id)
        assert row["current_holder_id"] == str(creator.id)
        assert row["current_holder_info"]["id"] == str(creator.id)
    finally:
        await _delete_file(db, file_id)
