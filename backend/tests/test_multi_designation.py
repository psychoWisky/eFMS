"""Multiple designations: chosen people (the Super Admin picks them, several at
once) can hold the SAME role in the SAME establishment/department more than
once, told apart by a designation, assigned from Edit User. Each post keeps its
own My Files / Docket and shows its designation in the recipient list and the
Docket. Everyone else keeps the one-per-place rule."""
import uuid

import pytest
from sqlalchemy import select, update as sa_update

from app.models.efms import EfmsFile
from app.models.user import SystemRole, User, UserRole
from tests.conftest import auth_headers as H
from tests.test_role_context_isolation import _cleanup, _estb, _ids, _new_file, _switch


async def _officer_in(db, users, estb, name="Ravi", designation="Professor", role=SystemRole.EFMS_OFFICER):
    """A person whose only post (of `role`) is in `estb` (no department)."""
    u = await users.make(role, first_name=name)
    row = (await db.execute(select(UserRole).where(UserRole.user_id == u.id))).scalar_one()
    row.establishment_id = uuid.UUID(estb)
    await db.execute(sa_update(User).where(User.id == u.id).values(establishment_id=uuid.UUID(estb), designation=designation))
    await db.commit()
    return u, row.id


def _row(estb, designation=None, role="efms_officer", dept=None):
    return {"role": role, "establishment_id": estb, "department_id": dept, "designation": designation}


async def _edit(client, admin, user, rows):
    return await client.patch(f"/auth/admin/users/{user.id}", json={"roles": rows}, headers=H(admin))


async def _allow(client, admin, *people):
    r = await client.post("/admin/multi-designation/users", json={"user_ids": [str(p.id) for p in people]}, headers=H(admin))
    assert r.status_code == 201, r.text
    return r.json()


async def _rows(db, uid):
    return (await db.execute(select(UserRole).where(UserRole.user_id == uid).execution_options(populate_existing=True))).scalars().all()


@pytest.mark.asyncio
async def test_only_chosen_people_can_hold_the_same_role_twice(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    estb = await _estb(client, admin)
    ravi, _ = await _officer_in(db, users, estb, designation="Professor")
    estb2 = await _estb(client, admin)
    gone, _ = await _officer_in(db, users, estb2, name="Gone")
    try:
        two = [_row(estb, "A"), _row(estb, "B")]
        # Not allowed yet.
        r = await _edit(client, admin, ravi, two)
        assert r.status_code == 409 and "Multiple designations" in r.json()["detail"]

        # Several people are allowed at once; someone already there or inactive is skipped.
        await db.execute(sa_update(User).where(User.id == gone.id).values(is_active=False)); await db.commit()
        out = await _allow(client, admin, ravi, gone)
        assert out["added"] == [ravi.full_name] and "not active" in out["skipped"][0]
        assert (await _allow(client, admin, ravi))["skipped"][0].endswith("(already on the list)")

        # Allowed: a post without a designation (the person's own) plus one with its own is fine ...
        r = await _edit(client, admin, ravi, [_row(estb), _row(estb, "In-charge, Library")])
        assert r.status_code == 200, r.text
        assert sorted(x["designation"] or "" for x in r.json()["roles"]) == ["", "In-charge, Library"]
        # ... but two without, two the same (any case), or one named like the person's own designation, are not.
        r = await _edit(client, admin, ravi, [_row(estb), _row(estb, "professor")])      # same as the person's own
        assert r.status_code == 400 and "designation" in r.json()["detail"]
        r = await _edit(client, admin, ravi, [_row(estb, "In-charge, Library"), _row(estb, "in-charge, library"), _row(estb)])
        assert r.status_code == 200 and len(r.json()["roles"]) == 2                       # the two identical ones are one
        r = await _edit(client, admin, ravi, [_row(estb), _row(estb, "")])
        assert r.status_code == 200 and len(r.json()["roles"]) == 1                       # identical → one

        # The list shows allowed people with their posts; they cannot leave it while holding duplicates.
        r = await _edit(client, admin, ravi, [_row(estb), _row(estb, "In-charge, Hostel"), _row(estb, "In-charge, Library")])
        assert r.status_code == 200 and len(r.json()["roles"]) == 3
        me = next(x for x in (await client.get("/admin/multi-designation", headers=H(admin))).json() if x["user"]["id"] == str(ravi.id))
        assert me["duplicate_places"] == 1 and len(me["posts"]) == 3 and all(p["shared_place"] for p in me["posts"])
        r = await client.delete(f"/admin/multi-designation/users/{ravi.id}", headers=H(admin))
        assert r.status_code == 409 and "Hostel" in r.json()["detail"]
        assert (await _edit(client, admin, ravi, [_row(estb)])).status_code == 200
        assert (await client.delete(f"/admin/multi-designation/users/{ravi.id}", headers=H(admin))).status_code == 204
        # off the list → back to one per place
        assert (await _edit(client, admin, ravi, two)).status_code == 409
    finally:
        await _cleanup(db, [], [estb, estb2])


@pytest.mark.asyncio
async def test_each_post_keeps_its_own_files_and_shows_its_designation(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    estb = await _estb(client, admin)
    ravi, row_a = await _officer_in(db, users, estb, designation="Professor")
    sender = await users.make(SystemRole.EFMS_OFFICER, first_name="Sender")
    files = []
    try:
        await _allow(client, admin, ravi)
        r = await _edit(client, admin, ravi, [_row(estb), _row(estb, "In-charge, Hostel")])
        assert r.status_code == 200, r.text
        row_b = uuid.UUID(next(x["id"] for x in r.json()["roles"] if x["designation"] == "In-charge, Hostel"))

        await _switch(client, ravi, row_a)
        fa = await _new_file(client, ravi, "Made as the first post"); files.append(fa)
        await _switch(client, ravi, row_b)
        fb = await _new_file(client, ravi, "Made as the Hostel post"); files.append(fb)
        mine = await _ids(client, ravi, "/efms/files", outbox="true")
        assert fb in mine and fa not in mine
        await _switch(client, ravi, row_a)
        mine = await _ids(client, ravi, "/efms/files", outbox="true")
        assert fa in mine and fb not in mine

        # The recipient list has one entry per post, each with its designation.
        r = await client.get("/admin/users", headers=H(sender))
        entries = [u for u in r.json() if u["id"] == str(ravi.id)]
        assert {e["user_role_id"]: e["designation"] for e in entries} == {str(row_a): "Professor", str(row_b): "In-charge, Hostel"}
        assert all(e["role_context"] and e["designation"] in e["role_context"] for e in entries)

        # Forwarded to the Hostel post while Ravi works as the first post: only the Hostel post sees it.
        fwd = await _new_file(client, sender, "For the Hostel in-charge"); files.append(fwd)
        r = await client.post(f"/efms/files/{fwd}/route", json={"action": "forward", "to_user_id": str(ravi.id),
                              "to_role": "efms_officer", "to_user_role_id": str(row_b)}, headers=H(sender))
        assert r.status_code == 200, r.text
        assert fwd not in await _ids(client, ravi, "/docket")
        await _switch(client, ravi, row_b)
        docket = {d["file_id"]: d for d in (await client.get("/docket", headers=H(ravi))).json()}
        assert fwd in docket and docket[fwd]["to_designation"] == "In-charge, Hostel"

        # Renaming a post's designation in Edit User keeps its files.
        r = await _edit(client, admin, ravi, [_row(estb), _row(estb, "Hostel Warden")])
        assert r.status_code == 200, r.text
        stamped = {str(f.id): f.creator_designation for f in (await db.execute(
            select(EfmsFile).where(EfmsFile.id.in_([uuid.UUID(fb), uuid.UUID(fa)])).execution_options(populate_existing=True))).scalars().all()}
        assert stamped[fb] == "Hostel Warden" and stamped[fa] is None
        assert fb in await _ids(client, ravi, "/efms/files", outbox="true")
    finally:
        await _cleanup(db, files, [estb])


@pytest.mark.asyncio
async def test_transfer_moves_one_post_with_its_designation(client, users, roles, db):
    """With a role that allows several people (a one-person role could not be
    split between two people)."""
    admin = await users.make(SystemRole.SUPER_ADMIN)
    estb = await _estb(client, admin)
    role = await roles.make(f"t_incharge_{uuid.uuid4().hex[:6]}")
    assert (await client.patch(f"/auth/admin/roles/{role.id}", json={"allow_multiple_holders": True}, headers=H(admin))).status_code == 200
    ravi, row_a = await _officer_in(db, users, estb, role=role.name)
    estb_p = await _estb(client, admin)
    priya, _ = await _officer_in(db, users, estb_p, name="Priya", role=role.name)
    other, _ = await _officer_in(db, users, estb, name="Other", role=role.name)       # already holds the role in estb
    files = []
    try:
        await _allow(client, admin, ravi)
        r = await _edit(client, admin, ravi, [_row(estb, None, role.name), _row(estb, "In-charge, Hostel", role.name)])
        assert r.status_code == 200, r.text
        row_b = uuid.UUID(next(x["id"] for x in r.json()["roles"] if x["designation"] == "In-charge, Hostel"))
        await _switch(client, ravi, row_a)
        fa = await _new_file(client, ravi, "A file"); files.append(fa)
        await _switch(client, ravi, row_b)
        fb = await _new_file(client, ravi, "B file"); files.append(fb)

        # A target who already holds the role there under another designation cannot receive a second one.
        r = await client.post(f"/auth/admin/users/{ravi.id}/transfer-role", json={"role": role.name, "user_role_id": str(row_b), "target_id": str(other.id)}, headers=H(admin))
        assert r.status_code == 409 and "Multiple designations" in r.json()["detail"], r.text

        # Someone without the role in that place simply receives the post, designation included.
        r = await client.post(f"/auth/admin/users/{ravi.id}/transfer-role", json={"role": role.name, "user_role_id": str(row_b), "target_id": str(priya.id)}, headers=H(admin))
        assert r.status_code == 200, r.text
        owner = {str(f.id): (f.created_by, f.creator_designation) for f in (await db.execute(
            select(EfmsFile).where(EfmsFile.id.in_([uuid.UUID(i) for i in files])).execution_options(populate_existing=True))).scalars().all()}
        assert owner[fb] == (priya.id, "In-charge, Hostel") and owner[fa][0] == ravi.id
        assert any(x.role == role.name and x.designation == "In-charge, Hostel" for x in await _rows(db, priya.id))
        assert len(await _rows(db, ravi.id)) == 1
    finally:
        await _cleanup(db, files, [estb, estb_p])
