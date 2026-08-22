"""Holding-period HolderNote history: A -> B -> C -> A -> D -> B.

Each distinct holding period gets its own, separately-preserved HolderNote
row (sequence 2, 3, 4, 5, 6 — 1 is reserved for the creator's immutable
initial Notesheet, a different table). A repeat holder (A the second time,
B the second time) must never overwrite their own earlier holding period's
content. Only the file's live current holder may edit the current
(is_current=True) row; every other row is permanently historical/read-only.
Also verifies this feature didn't disturb existing, unrelated authorization
(file access, forwarding, creator-only release, My Files).
"""
import pytest
from sqlalchemy import select, delete as sa_delete

from app.models.user import SystemRole
from app.models.efms import EfmsFile, DispatchRecord
from tests.conftest import auth_headers


async def _create_file(client, creator, subject="Holding period test file"):
    r = await client.post(
        "/efms/files",
        json={"subject": subject, "category": "general", "initial_content": "initial content"},
        headers=auth_headers(creator),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _forward(client, sender, recipient, file_id, remarks="fwd"):
    r = await client.post(
        f"/efms/files/{file_id}/route",
        json={"action": "forward", "to_user_id": str(recipient.id), "remarks": remarks},
        headers=auth_headers(sender),
    )
    assert r.status_code == 200, r.text
    return r.json()


async def _save_note(client, user, file_id, content):
    r = await client.patch(
        f"/efms/files/{file_id}/holder-notesheet",
        json={"content": content},
        headers=auth_headers(user),
    )
    return r


async def _list_notes(client, user, file_id):
    r = await client.get(f"/efms/files/{file_id}/holder-notesheets", headers=auth_headers(user))
    assert r.status_code == 200, r.text
    return r.json()


async def _delete_file(db, file_id):
    # DispatchRecord.file_id has no cascade (see prior investigation) —
    # must be cleared explicitly before the parent file can be deleted.
    await db.execute(sa_delete(DispatchRecord).where(DispatchRecord.file_id == file_id))
    f = await db.get(EfmsFile, file_id)
    if f:
        await db.delete(f)
        await db.commit()


async def _build_full_chain(client, users):
    """A creates -> B -> C -> A (repeat) -> D -> B (repeat), saving a note
    at each holding period. Returns (file_id, people, notes) where `people`
    maps role letters to User objects and `notes` maps them to the saved
    HolderNotesheetOut dicts."""
    A = await users.make(SystemRole.EFMS_OFFICER, first_name="A")
    B = await users.make(SystemRole.EFMS_OFFICER, first_name="B")
    C = await users.make(SystemRole.EFMS_OFFICER, first_name="C")
    D = await users.make(SystemRole.EFMS_OFFICER, first_name="D")

    file_id = await _create_file(client, A)

    await _forward(client, A, B, file_id)
    b1 = (await _save_note(client, B, file_id, "B first holding")).json()

    await _forward(client, B, C, file_id)
    c1 = (await _save_note(client, C, file_id, "C content")).json()

    await _forward(client, C, A, file_id)  # A receives it again
    a2 = (await _save_note(client, A, file_id, "A second holding")).json()

    await _forward(client, A, D, file_id)
    d1 = (await _save_note(client, D, file_id, "D content")).json()

    await _forward(client, D, B, file_id)  # B receives it again
    b2 = (await _save_note(client, B, file_id, "B second holding")).json()

    people = {"A": A, "B": B, "C": C, "D": D}
    notes = {"b1": b1, "c1": c1, "a2": a2, "d1": d1, "b2": b2}
    return file_id, people, notes


# ── 1-10: full lifecycle, repeat holders get distinct, non-overwritten records ──

@pytest.mark.asyncio
async def test_full_holding_period_lifecycle(client, users, db):
    file_id, people, notes = await _build_full_chain(client, users)
    try:
        # 1-2: B received and got a note; distinct row, sequence 2.
        assert notes["b1"]["sequence"] == 2
        assert notes["b1"]["content"] == "B first holding"

        # 3: C received and got a separate row, sequence 3.
        assert notes["c1"]["sequence"] == 3
        assert notes["c1"]["content"] == "C content"

        # 4-6: A receives it again -> a NEW record (sequence 4), distinct
        # from A having no row at all for their first holding (that's the
        # separate, immutable initial Notesheet).
        assert notes["a2"]["sequence"] == 4
        assert notes["a2"]["content"] == "A second holding"

        # 7-8: D receives -> new row, sequence 5.
        assert notes["d1"]["sequence"] == 5
        assert notes["d1"]["content"] == "D content"

        # 9-10: B receives again -> a NEW record (sequence 6), and B's
        # first-holding row (sequence 2) must be completely untouched.
        assert notes["b2"]["sequence"] == 6
        assert notes["b2"]["content"] == "B second holding"

        all_notes = await _list_notes(client, people["B"], file_id)
        by_seq = {n["sequence"]: n for n in all_notes}
        assert len(all_notes) == 5
        assert by_seq[2]["content"] == "B first holding"   # unchanged by B's later edit
        assert by_seq[2]["is_current"] is False
        assert by_seq[3]["content"] == "C content"
        assert by_seq[4]["content"] == "A second holding"  # A's two holdings are distinct
        assert by_seq[5]["content"] == "D content"
        assert by_seq[6]["content"] == "B second holding"
        assert by_seq[6]["is_current"] is True             # only the live one is current
        assert all(by_seq[s]["is_current"] is False for s in (2, 3, 4, 5))
    finally:
        await _delete_file(db, file_id)


# ── 11-12: current-holder-only edit, historical rows read-only ──────────────

@pytest.mark.asyncio
async def test_current_holder_can_edit_only_current_period(client, users, db):
    file_id, people, notes = await _build_full_chain(client, users)
    try:
        # B currently holds it (second time). B can still edit.
        r = await _save_note(client, people["B"], file_id, "B second holding, edited")
        assert r.status_code == 200
        assert r.json()["sequence"] == 6
        assert r.json()["content"] == "B second holding, edited"
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_historical_notesheets_cannot_be_edited(client, users, db):
    file_id, people, notes = await _build_full_chain(client, users)
    try:
        # A is no longer the current holder (B is) -> A cannot save at all,
        # meaning A's historical rows (sequence 4) are unreachable for writes.
        r = await _save_note(client, people["A"], file_id, "trying to overwrite history")
        assert r.status_code == 403

        # A's historical content must be exactly as originally saved.
        all_notes = await _list_notes(client, people["B"], file_id)
        a_note = next(n for n in all_notes if n["sequence"] == 4)
        assert a_note["content"] == "A second holding"
    finally:
        await _delete_file(db, file_id)


# ── 13: initial creator notesheet remains unchanged ──────────────────────────

@pytest.mark.asyncio
async def test_initial_creator_notesheet_remains_unchanged(client, users, db):
    file_id, people, notes = await _build_full_chain(client, users)
    try:
        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(people["B"]))
        assert r.status_code == 200
        assert r.json()["notesheet"]["content"] == "initial content"
    finally:
        await _delete_file(db, file_id)


# ── 14: numbering is chronological and stable ────────────────────────────────

@pytest.mark.asyncio
async def test_numbering_chronological_and_stable(client, users, db):
    """Sequence numbers must reflect creation order and never be
    recalculated from array/display order — fetching twice (or as
    different viewers) must return identical sequence numbers."""
    file_id, people, notes = await _build_full_chain(client, users)
    try:
        first = await _list_notes(client, people["B"], file_id)
        second = await _list_notes(client, people["B"], file_id)
        assert [n["sequence"] for n in first] == [2, 3, 4, 5, 6]
        assert [n["sequence"] for n in first] == [n["sequence"] for n in second]
    finally:
        await _delete_file(db, file_id)


# ── 16: released files show history but no editable current row ─────────────

@pytest.mark.asyncio
async def test_released_file_shows_history_no_editable_current(client, users, db):
    file_id, people, notes = await _build_full_chain(client, users)
    try:
        # B (current holder) forwards back to A (creator) so A can release.
        await _forward(client, people["B"], people["A"], file_id)
        r = await client.post(f"/docket/{file_id}/release", headers=auth_headers(people["A"]))
        assert r.status_code == 200

        super_admin = await users.make(SystemRole.SUPER_ADMIN)
        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(super_admin))
        assert r.status_code == 200
        assert r.json()["current_holder_id"] is None
        assert r.json()["is_released"] is True

        all_notes = await _list_notes(client, super_admin, file_id)
        # History (including the finalized row from A's post-release forward-back holding) is intact.
        assert len(all_notes) == 6
        assert all(n["is_current"] is False for n in all_notes)

        # No one has a current, editable holder-notesheet on a released file.
        r = await client.get(f"/efms/files/{file_id}/holder-notesheet", headers=auth_headers(super_admin))
        assert r.status_code == 200
        assert r.json() is None
    finally:
        await _delete_file(db, file_id)


# ── 17-19: existing authorization is unaffected ──────────────────────────────

@pytest.mark.asyncio
async def test_existing_file_access_authorization_still_works(client, users, db):
    file_id, people, notes = await _build_full_chain(client, users)
    try:
        outsider = await users.make(SystemRole.EFMS_OFFICER, first_name="Outsider")
        r = await client.get(f"/efms/files/{file_id}", headers=auth_headers(outsider))
        assert r.status_code == 403
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_existing_forwarding_authorization_still_works(client, users, db):
    file_id, people, notes = await _build_full_chain(client, users)
    try:
        # A is not the current holder (B is) -> A cannot forward.
        r = await client.post(
            f"/efms/files/{file_id}/route",
            json={"action": "forward", "to_user_id": str(people["C"].id), "remarks": "x"},
            headers=auth_headers(people["A"]),
        )
        assert r.status_code == 403
    finally:
        await _delete_file(db, file_id)


@pytest.mark.asyncio
async def test_existing_creator_only_release_authorization_still_works(client, users, db):
    file_id, people, notes = await _build_full_chain(client, users)
    try:
        # B currently holds it; B is not the creator (A is) -> B cannot release.
        r = await client.post(f"/docket/{file_id}/release", headers=auth_headers(people["B"]))
        assert r.status_code == 403
        assert "original creator" in r.json()["detail"]
    finally:
        await _delete_file(db, file_id)


# ── 20: My Files behavior unaffected ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_my_files_behavior_unchanged(client, users, db):
    file_id, people, notes = await _build_full_chain(client, users)
    try:
        r = await client.get("/efms/files?outbox=true", headers=auth_headers(people["A"]))
        assert r.status_code == 200
        ids = {f["id"] for f in r.json()}
        assert file_id in ids  # A created it -> still appears in A's My Files/outbox
    finally:
        await _delete_file(db, file_id)
