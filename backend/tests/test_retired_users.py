"""A person deactivated with the reason "Retired" keeps a limited login: the
Docket and the files sent to them — no creating files, no My Files / search /
tracking, no admin. Their old seat is free for a new person, files handed
over by Transfer Ownership are no longer theirs, and they can be sent files
and are labelled with the role and retirement date."""
import uuid

import pytest
from sqlalchemy import select, delete as sa_delete, update as sa_update

from app.models.efms import EfmsFile
from app.models.efms_extra import Docket
from app.models.organization import Department, Establishment
from app.models.user import SystemRole, User, UserRole, FormerRoleHolding
from tests.conftest import auth_headers

PWD = "Pytest@12345"
BYPASS = "987317"


def H(u):
    return auth_headers(u)


async def _estb_dept(client, admin):
    r = await client.post("/admin/establishments", json={"name": f"Ret-{uuid.uuid4().hex[:8]}", "code": uuid.uuid4().hex[:6]}, headers=H(admin))
    assert r.status_code == 201, r.text
    e = r.json()
    r = await client.post("/admin/departments", json={"name": f"RD-{uuid.uuid4().hex[:8]}", "code": uuid.uuid4().hex[:6], "establishment_id": e["id"]}, headers=H(admin))
    assert r.status_code == 201, r.text
    return e["id"], r.json()["id"]


def _mail(tag):
    return f"ret.{tag}.{uuid.uuid4().hex[:8]}@example.com"


async def _api_user(client, admin, role="registrar", estb=None, dept=None, tag="u", first="Ret"):
    email = _mail(tag)
    body = {"first_name": first, "last_name": tag.title(), "email": email, "mobile": "9" + str(uuid.uuid4().int)[:9],
            "designation": "Clerk", "role": role, "is_active": True, "temp_password": PWD}
    if estb: body["establishment_id"] = estb
    if dept: body["department_id"] = dept
    r = await client.post("/auth/admin/users", json=body, headers=H(admin))
    assert r.status_code == 201, r.text
    uid = r.json()["id"]
    return uid, email


async def _ready(db, uid):
    """Skip the first-login steps so the account can work straight away."""
    await db.execute(sa_update(User).where(User.id == uid).values(must_change_password=False, kyc_completed=True))
    await db.commit()


async def _status(client, admin, uid, active, reason="retired"):
    body = {"is_active": active}
    if not active:
        body["reason_type"] = reason
    return await client.patch(f"/auth/admin/users/{uid}/status", json=body, headers=H(admin))


async def _login(client, email):
    r = await client.post("/auth/login/step1", json={"identifier": email, "password": PWD})
    if r.status_code != 200:
        return r, None
    r2 = await client.post("/auth/login/step2", json={"identifier": email, "otp": BYPASS})
    return r2, {"Authorization": f"Bearer {r2.json()['access_token']}"} if r2.status_code == 200 else None


async def _new_file(client, headers, subject="Retired user test file"):
    return await client.post("/efms/files", json={"subject": subject, "category": "general", "initial_content": "x"}, headers=headers)


async def _cleanup(db, uids=(), file_ids=(), estbs=(), depts=()):
    for fid in file_ids:
        fid = uuid.UUID(fid)
        await db.execute(sa_delete(Docket).where(Docket.file_id == fid))
        f = await db.get(EfmsFile, fid)
        if f:
            await db.delete(f)
    await db.commit()
    ids = [uuid.UUID(u) for u in uids]
    if ids:
        await db.execute(sa_update(User).where(User.deactivated_by.in_(ids)).values(deactivated_by=None))
        await db.execute(sa_delete(FormerRoleHolding).where(FormerRoleHolding.user_id.in_(ids)))
        await db.execute(sa_delete(UserRole).where(UserRole.user_id.in_(ids)))
        await db.execute(sa_delete(User).where(User.id.in_(ids)))
    await db.commit()
    for d in depts:
        await db.execute(sa_delete(Department).where(Department.id == uuid.UUID(d)))
    for e in estbs:
        await db.execute(sa_delete(Establishment).where(Establishment.id == uuid.UUID(e)))
    await db.commit()


@pytest.mark.asyncio
async def test_only_retired_people_can_still_sign_in(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    uids = []
    try:
        for reason, can_login in (("retired", True), ("resigned", False), ("suspended", False), ("other", False)):
            uid, email = await _api_user(client, admin, tag=reason)
            uids.append(uid)
            await _ready(db, uid)
            assert (await _status(client, admin, uid, False, reason)).status_code == 200
            r, headers = await _login(client, email)
            assert (r.status_code == 200) is can_login, (reason, r.status_code, r.text)
            if can_login:
                user = r.json()["user"]
                assert user["is_retired"] is True and user["retired_at"]
        # reactivating returns them to normal
        assert (await _status(client, admin, uids[0], True)).status_code == 200
        r, headers = await _login(client, (await db.get(User, uuid.UUID(uids[0]))).email)
        assert r.status_code == 200 and r.json()["user"]["is_retired"] is False
    finally:
        await _cleanup(db, uids)


@pytest.mark.asyncio
async def test_retired_person_has_the_docket_only(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    uid, email = await _api_user(client, admin, tag="docketonly")
    try:
        await _ready(db, uid)
        assert (await _status(client, admin, uid, False)).status_code == 200
        _, h = await _login(client, email)

        assert (await client.get("/docket", headers=h)).status_code == 200
        assert (await client.get("/auth/me", headers=h)).status_code == 200
        assert (await client.get("/admin/users", headers=h)).status_code == 200      # recipient list, to forward files
        for method, path, body in (
            ("post", "/efms/files", {"subject": "Not allowed file", "category": "general", "initial_content": "x"}),
            ("get", "/efms/files", None),
            ("get", "/efms/files/search", None),
            ("get", "/tracking/history", None),
            ("get", "/docket/released", None),
            ("get", "/docket/released/mine", None),
            ("post", f"/docket/{uuid.uuid4()}/reopen", None),
        ):
            r = await (client.post(path, json=body, headers=h) if method == "post" else client.get(path, headers=h))
            assert r.status_code == 403, (path, r.status_code, r.text)
            assert "retired" in r.json()["detail"].lower(), (path, r.text)
    finally:
        await _cleanup(db, [uid])


@pytest.mark.asyncio
async def test_a_retired_super_admin_has_no_admin_powers(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    uid, email = await _api_user(client, admin, role="super_admin", tag="sa")
    try:
        await _ready(db, uid)
        assert (await _status(client, admin, uid, False)).status_code == 200
        _, h = await _login(client, email)
        for path in ("/auth/admin/users", "/projects", "/auth/admin/roles"):
            assert (await client.get(path, headers=h)).status_code == 403, path
    finally:
        await _cleanup(db, [uid])


@pytest.mark.asyncio
async def test_files_can_be_forwarded_to_and_worked_by_a_retired_person(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    sender = await users.make(SystemRole.EFMS_OFFICER, first_name="Sender")
    nxt = await users.make(SystemRole.EFMS_OFFICER, first_name="Next")
    uid, email = await _api_user(client, admin, tag="worker")
    files = []
    try:
        await _ready(db, uid)
        assert (await _status(client, admin, uid, False)).status_code == 200
        _, h = await _login(client, email)

        r = await _new_file(client, H(sender)); assert r.status_code == 201, r.text
        fid = r.json()["id"]; files.append(fid)
        r = await client.post(f"/efms/files/{fid}/route", json={"action": "forward", "to_user_id": uid}, headers=H(sender))
        assert r.status_code == 200, r.text                       # forwarding to a retired person is allowed

        docket = (await client.get("/docket", headers=h)).json()
        assert fid in {d["file_id"] for d in docket}              # shows up in their Docket
        assert (await client.get(f"/efms/files/{fid}", headers=h)).status_code == 200

        # everything except creating: write a note, then forward onward
        r = await client.patch(f"/efms/files/{fid}/holder-notesheet", json={"content": "<p>Seen by retired holder</p>"}, headers=h)
        assert r.status_code == 200, r.text
        r = await client.post(f"/efms/files/{fid}/route", json={"action": "forward", "to_user_id": str(nxt.id)}, headers=h)
        assert r.status_code == 200, r.text
        assert fid not in {d["file_id"] for d in (await client.get("/docket", headers=h)).json()}
        assert fid in {d["file_id"] for d in (await client.get("/docket", headers=H(nxt))).json()}
    finally:
        await _cleanup(db, [uid], files)


@pytest.mark.asyncio
async def test_files_handed_over_by_transfer_are_not_the_retired_persons_any_more(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    sender = await users.make(SystemRole.EFMS_OFFICER, first_name="Sender")
    estb, dept = await _estb_dept(client, admin)
    old_id, old_mail = await _api_user(client, admin, role="registrar", estb=estb, dept=dept, tag="old")
    new_id, new_mail = await _api_user(client, admin, role="hod", estb=estb, dept=dept, tag="new")
    files = []
    try:
        await _ready(db, old_id); await _ready(db, new_id)
        # a file reaches the old holder while still in office
        r = await _new_file(client, H(sender)); fid = r.json()["id"]; files.append(fid)
        assert (await client.post(f"/efms/files/{fid}/route", json={"action": "forward", "to_user_id": old_id}, headers=H(sender))).status_code == 200
        _, old_h = await _login(client, old_mail)
        assert fid in {d["file_id"] for d in (await client.get("/docket", headers=old_h)).json()}

        # role + files handed to the new person, then the old one retires
        r = await client.post(f"/auth/admin/users/{old_id}/transfer-role", json={"role": "registrar", "target_id": new_id}, headers=H(admin))
        assert r.status_code == 200, r.text
        assert (await _status(client, admin, old_id, False)).status_code == 200
        _, old_h = await _login(client, old_mail)
        assert fid not in {d["file_id"] for d in (await client.get("/docket", headers=old_h)).json()}
        _, new_h = await _login(client, new_mail)
        # the file lives in the Registrar workspace the new person just took over
        r = await client.post("/auth/switch-role", json={"role": "registrar"}, headers=new_h)
        assert r.status_code == 200, r.text
        new_h = {"Authorization": f"Bearer {r.json()['access_token']}"}
        assert fid in {d["file_id"] for d in (await client.get("/docket", headers=new_h)).json()}
        # the retired person cannot open it any more either
        assert (await client.get(f"/efms/files/{fid}", headers=old_h)).status_code in (403, 404)

        # they are still labelled with the role they handed over
        r = await client.get("/admin/users", headers=H(sender))
        entry = next(u for u in r.json() if u["id"] == old_id)
        assert entry["is_retired"] is True and entry["retired_roles"] == ["registrar"] and entry["retired_at"]
    finally:
        await _cleanup(db, [old_id, new_id], files, [estb], [dept])


@pytest.mark.asyncio
async def test_the_seat_of_a_retired_person_is_free_for_a_new_holder(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    estb, dept = await _estb_dept(client, admin)
    a_id, _ = await _api_user(client, admin, role="registrar", estb=estb, dept=dept, tag="a")
    uids = [a_id]
    try:
        # while A is in office the seat is taken
        body = {"first_name": "B", "last_name": "New", "email": _mail("b"), "mobile": "9" + str(uuid.uuid4().int)[:9],
                "designation": "Clerk", "role": "registrar", "establishment_id": estb, "department_id": dept,
                "is_active": True, "temp_password": PWD}
        assert (await client.post("/auth/admin/users", json=body, headers=H(admin))).status_code == 409
        # once A retires, a new person can take the role
        assert (await _status(client, admin, a_id, False)).status_code == 200
        r = await client.post("/auth/admin/users", json=body, headers=H(admin))
        assert r.status_code == 201, r.text
        uids.append(r.json()["id"])
        # A's role is remembered for the label even though nothing was transferred
        entry = next(u for u in (await client.get("/admin/users", headers=H(admin))).json() if u["id"] == a_id)
        assert entry["is_retired"] and entry["retired_roles"] == ["registrar"]
    finally:
        await _cleanup(db, uids, [], [estb], [dept])


@pytest.mark.asyncio
async def test_several_retired_people_of_one_role_can_be_told_apart(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    viewer = await users.make(SystemRole.EFMS_OFFICER, first_name="Viewer")
    estb, dept = await _estb_dept(client, admin)
    uids = []
    try:
        for i, first in enumerate(("Asha", "Binod")):
            uid, _ = await _api_user(client, admin, role="registrar", estb=estb, dept=dept, tag=f"r{i}", first=first)
            uids.append(uid)
            assert (await _status(client, admin, uid, False)).status_code == 200   # frees the seat for the next one
        entries = [u for u in (await client.get("/admin/users", headers=H(viewer))).json() if u["id"] in uids]
        assert len(entries) == 2 and all(e["is_retired"] and e["retired_roles"] == ["registrar"] for e in entries)
        assert len({e["full_name"] for e in entries}) == 2           # different names ...
        assert all(e["retired_at"] for e in entries)                  # ... each with its own retirement date
        # a retired person is not offered to themselves
        _, h = await _login(client, next(e["email"] for e in entries if e["id"] == uids[0]) if "email" in entries[0] else (await db.get(User, uuid.UUID(uids[0]))).email)
        mine = {u["id"] for u in (await client.get("/admin/users", headers=h)).json()}
        assert uids[0] not in mine
    finally:
        await _cleanup(db, uids, [], [estb], [dept])
