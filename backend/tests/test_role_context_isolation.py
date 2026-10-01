"""One person holding the SAME role name in two establishments: My Files /
Docket stay separate per role, a forward lands in the chosen role only, and
Transfer Ownership hands over exactly one of the two roles (with that
role's files, including released ones). See app/utils/workspace.py."""
import uuid

import pytest
from sqlalchemy import select, delete as sa_delete, update as sa_update

from app.models.efms import EfmsFile, DispatchRecord
from app.models.efms_extra import Docket
from app.models.organization import Establishment
from app.models.user import SystemRole, User, UserRole
from tests.conftest import auth_headers


async def _estb(client, admin):
    r = await client.post(
        "/admin/establishments",
        json={"name": f"Ctx-{uuid.uuid4().hex[:8]}", "code": uuid.uuid4().hex[:6]},
        headers=auth_headers(admin),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _two_context_officer(db, users, name, estb_x, estb_y):
    """An efms_officer holding that role in establishment X and again in Y."""
    u = await users.make(SystemRole.EFMS_OFFICER, first_name=name)
    row_x = (await db.execute(select(UserRole).where(UserRole.user_id == u.id))).scalar_one()
    row_x.establishment_id = uuid.UUID(estb_x)
    row_y = UserRole(user_id=u.id, role="efms_officer", establishment_id=uuid.UUID(estb_y))
    db.add(row_y)
    (await db.get(User, u.id)).establishment_id = uuid.UUID(estb_x)
    await db.commit()
    return u, row_x.id, row_y.id


async def _switch(client, user, row_id):
    r = await client.post(
        "/auth/switch-role",
        json={"role": "efms_officer", "user_role_id": str(row_id)},
        headers=auth_headers(user),
    )
    assert r.status_code == 200, r.text


async def _new_file(client, user, subject):
    r = await client.post(
        "/efms/files",
        json={"subject": subject, "category": "general", "initial_content": "content"},
        headers=auth_headers(user),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _ids(client, user, path, **params):
    r = await client.get(path, params=params, headers=auth_headers(user))
    assert r.status_code == 200, r.text
    return {f.get("id") or f.get("file_id") for f in r.json()}


async def _cleanup(db, file_ids, estb_ids):
    for fid in file_ids:
        fid = uuid.UUID(fid)
        await db.execute(sa_delete(Docket).where(Docket.file_id == fid))
        await db.execute(sa_delete(DispatchRecord).where(DispatchRecord.file_id == fid))
        f = await db.get(EfmsFile, fid)
        if f:
            await db.delete(f)
    await db.commit()
    estbs = [uuid.UUID(e) for e in estb_ids]
    # The test users (removed by the `users` fixture afterwards) still point
    # at these establishments — detach them first.
    await db.execute(sa_delete(UserRole).where(UserRole.establishment_id.in_(estbs)))
    await db.execute(sa_update(User).where(User.establishment_id.in_(estbs)).values(establishment_id=None))
    await db.execute(sa_delete(Establishment).where(Establishment.id.in_(estbs)))
    await db.commit()


@pytest.mark.asyncio
async def test_same_role_in_two_establishments_keeps_files_apart(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    x, y = await _estb(client, admin), await _estb(client, admin)
    ravi, row_x, row_y = await _two_context_officer(db, users, "Ravi", x, y)
    sender = await users.make(SystemRole.EFMS_OFFICER, first_name="Sender")
    files = []
    try:
        await _switch(client, ravi, row_x)
        in_x = await _new_file(client, ravi, "File made in X"); files.append(in_x)
        await _switch(client, ravi, row_y)
        in_y = await _new_file(client, ravi, "File made in Y"); files.append(in_y)
        assert in_y in await _ids(client, ravi, "/efms/files", outbox="true")
        assert in_x not in await _ids(client, ravi, "/efms/files", outbox="true")
        await _switch(client, ravi, row_x)
        mine = await _ids(client, ravi, "/efms/files", outbox="true")
        assert in_x in mine and in_y not in mine

        # The recipient picker offers one entry per role, naming its context.
        r = await client.get("/admin/users", headers=auth_headers(sender))
        entries = [u for u in r.json() if u["id"] == str(ravi.id)]
        assert {e["user_role_id"] for e in entries} == {str(row_x), str(row_y)}

        # Forwarded to the Y role while Ravi is acting in X: only Y sees it.
        fwd = await _new_file(client, sender, "Forward to Y role"); files.append(fwd)
        r = await client.post(
            f"/efms/files/{fwd}/route",
            json={"action": "forward", "to_user_id": str(ravi.id), "to_role": "efms_officer",
                  "to_user_role_id": str(row_y)},
            headers=auth_headers(sender),
        )
        assert r.status_code == 200, r.text
        assert fwd not in await _ids(client, ravi, "/docket")
        await _switch(client, ravi, row_y)
        assert fwd in await _ids(client, ravi, "/docket")
    finally:
        await _cleanup(db, files, [x, y])


@pytest.mark.asyncio
async def test_transfer_hands_over_exactly_one_of_two_same_named_roles(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    x, y = await _estb(client, admin), await _estb(client, admin)
    ravi, row_x, row_y = await _two_context_officer(db, users, "Ravi", x, y)
    priya = await users.make(SystemRole.EFMS_OFFICER, first_name="Priya")
    amit = await users.make(SystemRole.EFMS_OFFICER, first_name="Amit")
    files = []
    try:
        await _switch(client, ravi, row_x)
        fx = await _new_file(client, ravi, "Ravi file in X"); files.append(fx)
        rx = await _new_file(client, ravi, "Ravi released in X"); files.append(rx)
        assert (await client.post(f"/docket/{rx}/release", headers=auth_headers(ravi))).status_code == 200
        await _switch(client, ravi, row_y)
        fy = await _new_file(client, ravi, "Ravi file in Y"); files.append(fy)
        ry = await _new_file(client, ravi, "Ravi released in Y"); files.append(ry)
        assert (await client.post(f"/docket/{ry}/release", headers=auth_headers(ravi))).status_code == 200

        # Both roles are listed separately, each naming its establishment.
        r = await client.get(f"/auth/admin/users/{ravi.id}/transfer-status", headers=auth_headers(admin))
        roles = [i for i in r.json()["items"] if i["kind"] == "role"]
        assert {i["user_role_id"] for i in roles} == {str(row_x), str(row_y)}
        assert all(i["context_label"] for i in roles)

        # The role name alone is ambiguous now.
        r = await client.post(f"/auth/admin/users/{ravi.id}/transfer-role",
                              json={"role": "efms_officer", "target_id": str(priya.id)},
                              headers=auth_headers(admin))
        assert r.status_code == 400, r.text

        # X -> Priya: only X's files move.
        r = await client.post(f"/auth/admin/users/{ravi.id}/transfer-role",
                              json={"role": "efms_officer", "user_role_id": str(row_x),
                                    "target_id": str(priya.id)}, headers=auth_headers(admin))
        assert r.status_code == 200, r.text
        owner = {f.id: f.created_by for f in (await db.execute(
            select(EfmsFile).where(EfmsFile.id.in_([uuid.UUID(i) for i in files]))
            .execution_options(populate_existing=True))).scalars().all()}
        assert owner[uuid.UUID(fx)] == priya.id and owner[uuid.UUID(rx)] == priya.id
        assert owner[uuid.UUID(fy)] == ravi.id and owner[uuid.UUID(ry)] == ravi.id

        # Y -> Amit: nothing is left with Ravi, and he can be retired.
        r = await client.post(f"/auth/admin/users/{ravi.id}/transfer-role",
                              json={"role": "efms_officer", "user_role_id": str(row_y),
                                    "target_id": str(amit.id)}, headers=auth_headers(admin))
        assert r.status_code == 200, r.text
        assert r.json()["can_retire"] is True
        a_rows = (await db.execute(select(UserRole).where(UserRole.user_id == amit.id)
                  .execution_options(populate_existing=True))).scalars().all()
        a_y = next(u for u in a_rows if u.establishment_id == uuid.UUID(y))
        await _switch(client, amit, a_y.id)
        mine = await _ids(client, amit, "/efms/files", outbox="true")
        assert fy in mine and fx not in mine
    finally:
        await _cleanup(db, files, [x, y])
