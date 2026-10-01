"""Renaming a custom role: files follow the new name (so they stay in the
right Docket / My Files), routing history reads "New Name (formerly Old
Name)", and the Roles list shows the earlier names."""
import pytest
from uuid import UUID
from sqlalchemy import select, delete as sa_delete

from app.models.efms import EfmsFile
from app.models.user import SystemRole
from tests.conftest import auth_headers


async def _rename(client, admin, role, new_name, show_formerly=None):
    body = {"name": new_name}
    if show_formerly is not None:
        body["show_formerly"] = show_formerly
    r = await client.patch(f"/auth/admin/roles/{role.id}", json=body, headers=auth_headers(admin))
    assert r.status_code == 200, r.text
    return r.json()


async def _ids(client, user, path, **params):
    r = await client.get(path, params=params, headers=auth_headers(user))
    assert r.status_code == 200, r.text
    return {f.get("id") or f.get("file_id") for f in r.json()}


async def _track(client, user, fid):
    r = await client.get(f"/efms/files/{fid}/track", headers=auth_headers(user))
    assert r.status_code == 200, r.text
    return [e for e in r.json() if e["type"] == "route"]


async def _forward(client, sender, to_user, fid):
    r = await client.post(
        f"/efms/files/{fid}/route",
        json={"action": "forward", "to_user_id": str(to_user.id)},
        headers=auth_headers(sender),
    )
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_rename_keeps_files_visible_and_records_formerly(client, users, roles, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    role = await roles.make("test_rename_old")
    alice = await users.make(role.name, first_name="Alice")
    bob = await users.make(role.name, first_name="Bob")

    r = await client.post(
        "/efms/files",
        json={"subject": "Rename follow test file", "category": "general", "initial_content": "x"},
        headers=auth_headers(alice),
    )
    assert r.status_code == 201, r.text
    fid = r.json()["id"]
    try:
        await _forward(client, alice, bob, fid)
        assert fid in await _ids(client, alice, "/efms/files", outbox="true")
        assert fid in await _ids(client, bob, "/docket")
        updated_before = (await db.get(EfmsFile, UUID(fid))).updated_at

        # ── first rename ──
        out = await _rename(client, admin, role, "test_rename_mid")
        assert out["name"] == "test_rename_mid" and out["former_names"] == ["test_rename_old"]
        # the files did not vanish
        assert fid in await _ids(client, alice, "/efms/files", outbox="true")
        assert fid in await _ids(client, bob, "/docket")
        steps = await _track(client, alice, fid)
        assert steps[0]["from_role"] == "test_rename_mid" and steps[0]["from_role_formerly"] == "test_rename_old"
        assert steps[0]["to_role"] == "test_rename_mid" and steps[0]["to_role_formerly"] == "test_rename_old"
        # renaming must not reorder anyone's lists
        row = (await db.execute(select(EfmsFile).where(EfmsFile.id == UUID(fid))
               .execution_options(populate_existing=True))).scalar_one()
        assert row.updated_at == updated_before
        assert row.creator_role == "test_rename_mid" and row.current_holder_role == "test_rename_mid"

        # a hop recorded AFTER the rename has no "formerly"
        await _forward(client, bob, alice, fid)
        steps = await _track(client, alice, fid)
        assert steps[1]["from_role"] == "test_rename_mid" and steps[1]["from_role_formerly"] is None

        # ── second rename: each hop keeps the wording it was recorded under ──
        out = await _rename(client, admin, role, "test_rename_new")
        assert out["former_names"] == ["test_rename_old", "test_rename_mid"]
        steps = await _track(client, alice, fid)
        assert steps[0]["from_role"] == "test_rename_new" and steps[0]["from_role_formerly"] == "test_rename_old"
        assert steps[1]["from_role"] == "test_rename_new" and steps[1]["from_role_formerly"] == "test_rename_mid"
        assert fid in await _ids(client, alice, "/docket")  # bob forwarded it back to alice

        # Roles list shows the earlier names
        r = await client.get("/auth/admin/roles", headers=auth_headers(admin))
        listed = next(x for x in r.json() if x["id"] == str(role.id))
        assert listed["former_names"] == ["test_rename_old", "test_rename_mid"]

        # the role is "used" under its current name, so it cannot be deleted
        r = await client.delete(f"/auth/admin/roles/{role.id}", headers=auth_headers(admin))
        assert r.status_code == 409
    finally:
        f = await db.get(EfmsFile, UUID(fid))
        if f:
            await db.delete(f)
            await db.commit()


@pytest.mark.asyncio
async def test_renaming_only_the_description_changes_no_history(client, users, roles):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    role = await roles.make("test_rename_desc")
    r = await client.patch(f"/auth/admin/roles/{role.id}", json={"description": "Just a note"}, headers=auth_headers(admin))
    assert r.status_code == 200 and r.json()["former_names"] == []
    # re-submitting the same name is not a rename either
    r = await client.patch(f"/auth/admin/roles/{role.id}", json={"name": role.name}, headers=auth_headers(admin))
    assert r.status_code == 200 and r.json()["former_names"] == []


@pytest.mark.asyncio
async def test_rename_can_show_only_the_new_name(client, users, roles, db):
    """The Super Admin may choose NOT to show the old name: files still
    follow the rename, but no "formerly" appears anywhere — and that choice
    also hides an earlier "formerly" for the same role."""
    admin = await users.make(SystemRole.SUPER_ADMIN)
    role = await roles.make("test_hide_old")
    alice = await users.make(role.name, first_name="Alice")
    bob = await users.make(role.name, first_name="Bob")
    r = await client.post(
        "/efms/files",
        json={"subject": "Rename hide test file", "category": "general", "initial_content": "x"},
        headers=auth_headers(alice),
    )
    assert r.status_code == 201, r.text
    fid = r.json()["id"]
    try:
        await _forward(client, alice, bob, fid)

        # Rename 1: show "formerly" (also the default when the choice is omitted)
        out = await _rename(client, admin, role, "test_hide_mid", show_formerly=True)
        assert out["former_names"] == ["test_hide_old"]
        steps = await _track(client, alice, fid)
        assert steps[0]["from_role_formerly"] == "test_hide_old"

        # Rename 2: new name only -> files follow, but nothing says "formerly"
        out = await _rename(client, admin, role, "test_hide_new", show_formerly=False)
        assert out["name"] == "test_hide_new" and out["former_names"] == []
        assert fid in await _ids(client, alice, "/efms/files", outbox="true")
        assert fid in await _ids(client, bob, "/docket")
        steps = await _track(client, alice, fid)
        assert steps[0]["from_role"] == "test_hide_new" and steps[0]["from_role_formerly"] is None
        assert steps[0]["to_role"] == "test_hide_new" and steps[0]["to_role_formerly"] is None
        r = await client.get("/auth/admin/roles", headers=auth_headers(admin))
        assert next(x for x in r.json() if x["id"] == str(role.id))["former_names"] == []

        # Rename 3: show again -> only this rename's old name is shown
        out = await _rename(client, admin, role, "test_hide_last")
        assert out["former_names"] == ["test_hide_new"]
        steps = await _track(client, alice, fid)
        assert steps[0]["from_role"] == "test_hide_last" and steps[0]["from_role_formerly"] == "test_hide_new"
    finally:
        f = await db.get(EfmsFile, UUID(fid))
        if f:
            await db.delete(f)
            await db.commit()
