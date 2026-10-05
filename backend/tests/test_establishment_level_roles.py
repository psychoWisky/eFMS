"""A role can be given to a whole ESTABLISHMENT (no department) — the
department is optional. Such a seat is independent of the department seats
inside the establishment, follows the role's one-person / many-people
setting, keeps its files apart from the department-level role of the same
person, and is protected by the delete guards."""
import csv
import io
import uuid

import pytest
from sqlalchemy import select, update as sa_update, delete as sa_delete

from app.models.efms import EfmsFile
from app.models.efms_extra import Docket
from app.models.user import SystemRole, User
from tests.conftest import auth_headers
from tests.test_delete_guards_and_seats import _api_user, _dept, _drop_org, _drop_user, _estb, _mail, H


async def _ready(db, uid):
    await db.execute(sa_update(User).where(User.id == uuid.UUID(uid)).values(must_change_password=False, kyc_completed=True))
    await db.commit()


async def _headers_of(db, uid):
    return auth_headers(await db.get(User, uuid.UUID(uid)))


async def _files(db, ids):
    for fid in ids:
        fid = uuid.UUID(fid)
        await db.execute(sa_delete(Docket).where(Docket.file_id == fid))
        f = await db.get(EfmsFile, fid)
        if f:
            await db.delete(f)
    await db.commit()


@pytest.mark.asyncio
async def test_a_role_can_be_held_for_the_whole_establishment(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    e, other_e = await _estb(client, admin), await _estb(client, admin)
    d = await _dept(client, admin, e["id"])
    emails = []
    try:
        r, m = await _api_user(client, admin, role="registrar", estb=e["id"], tag="whole1", first="Whole")
        assert r.status_code == 201, r.text
        emails.append(m)
        assert r.json()["establishment_id"] == e["id"] and r.json()["department_id"] is None

        # one-person role: a second holder of the SAME whole-establishment seat is refused,
        # and the message talks about the establishment (no department)
        r, m = await _api_user(client, admin, role="registrar", estb=e["id"], tag="whole2")
        assert r.status_code == 409, r.text
        detail = r.json()["detail"]
        assert "already assigned to Whole" in detail and f"establishment “{e['name']}”" in detail and "department" not in detail.split("already assigned")[0]

        # the department seat inside it, and another establishment's whole seat, are separate places
        for kw in (dict(estb=e["id"], dept=d["id"]), dict(estb=other_e["id"])):
            r, m = await _api_user(client, admin, role="registrar", tag="sep", **kw)
            assert r.status_code == 201, (kw, r.text)
            emails.append(m)
    finally:
        for m in emails:
            await _drop_user(db, m)
        await _drop_org(db, [e["id"], other_e["id"]], [d["id"]])


@pytest.mark.asyncio
async def test_many_people_can_share_a_whole_establishment_role(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    e = await _estb(client, admin)
    emails = []
    try:
        for i in range(3):   # faculty is a many-people role
            r, m = await _api_user(client, admin, role="faculty", estb=e["id"], tag=f"fac{i}")
            assert r.status_code == 201, r.text
            emails.append(m)
        # ...and a one-person role is still limited to one in the same place
        r, m = await _api_user(client, admin, role="hod", estb=e["id"], tag="hod1"); assert r.status_code == 201; emails.append(m)
        r, _ = await _api_user(client, admin, role="hod", estb=e["id"], tag="hod2"); assert r.status_code == 409
    finally:
        for m in emails:
            await _drop_user(db, m)
        await _drop_org(db, [e["id"]], [])


@pytest.mark.asyncio
async def test_edit_user_can_add_a_whole_establishment_role(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    e = await _estb(client, admin)
    d = await _dept(client, admin, e["id"])
    emails = []
    try:
        r, m = await _api_user(client, admin, role="registrar", estb=e["id"], dept=d["id"], tag="multi"); assert r.status_code == 201; emails.append(m)
        uid = r.json()["id"]
        # keep the department role and ALSO hold the same role for the whole establishment
        r = await client.patch(f"/auth/admin/users/{uid}", json={"roles": [
            {"role": "registrar", "establishment_id": e["id"], "department_id": d["id"]},
            {"role": "registrar", "establishment_id": e["id"], "department_id": None}]}, headers=H(admin))
        assert r.status_code == 200, r.text
        held = {(x["role"], x["department_id"]) for x in r.json()["roles"]}
        assert held == {("registrar", d["id"]), ("registrar", None)}

        # someone else cannot take the whole-establishment seat now ...
        r2, m2 = await _api_user(client, admin, role="hod", estb=e["id"], tag="other"); assert r2.status_code == 201; emails.append(m2)
        r = await client.patch(f"/auth/admin/users/{r2.json()['id']}", json={"roles": [
            {"role": "hod", "establishment_id": e["id"], "department_id": None},
            {"role": "registrar", "establishment_id": e["id"], "department_id": None}]}, headers=H(admin))
        assert r.status_code == 409 and "already assigned" in r.json()["detail"]
        # ... and the same seat twice on one person is a plain duplicate
        r = await client.patch(f"/auth/admin/users/{uid}", json={"roles": [
            {"role": "registrar", "establishment_id": e["id"], "department_id": None},
            {"role": "registrar", "establishment_id": e["id"], "department_id": None}]}, headers=H(admin))
        assert r.status_code == 200 and len(r.json()["roles"]) == 1   # collapsed, not doubled
    finally:
        for m in emails:
            await _drop_user(db, m)
        await _drop_org(db, [e["id"]], [d["id"]])


@pytest.mark.asyncio
async def test_whole_establishment_and_department_roles_keep_their_files_apart(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    sender = await users.make(SystemRole.EFMS_OFFICER, first_name="Sender")
    e = await _estb(client, admin)
    d = await _dept(client, admin, e["id"])
    emails, files = [], []
    try:
        r, m = await _api_user(client, admin, role="registrar", estb=e["id"], dept=d["id"], tag="both"); assert r.status_code == 201
        emails.append(m); uid = r.json()["id"]; await _ready(db, uid)
        r = await client.patch(f"/auth/admin/users/{uid}", json={"roles": [
            {"role": "registrar", "establishment_id": e["id"], "department_id": d["id"]},
            {"role": "registrar", "establishment_id": e["id"], "department_id": None}]}, headers=H(admin))
        assert r.status_code == 200, r.text
        row_dept = next(x["id"] for x in r.json()["roles"] if x["department_id"] == d["id"])
        row_whole = next(x["id"] for x in r.json()["roles"] if x["department_id"] is None)

        async def switch(row_id):
            r = await client.post("/auth/switch-role", json={"role": "registrar", "user_role_id": row_id}, headers=await _headers_of(db, uid))
            assert r.status_code == 200, r.text
            return {"Authorization": f"Bearer {r.json()['access_token']}"}, r.json()["user"]

        async def mine(h):
            return {f["id"] for f in (await client.get("/efms/files", params={"outbox": "true"}, headers=h)).json()}

        async def docket(h):
            return {f["file_id"] for f in (await client.get("/docket", headers=h)).json()}

        # a file made while acting for the whole establishment
        h_whole, brief = await switch(row_whole)
        assert brief["establishment_id"] == e["id"] and brief["department_id"] is None
        r = await client.post("/efms/files", json={"subject": "Whole establishment file", "category": "general", "initial_content": "x"}, headers=h_whole)
        assert r.status_code == 201, r.text
        f_whole = r.json()["id"]; files.append(f_whole)
        # ... is not visible while acting for the department, and vice versa
        h_dept, brief = await switch(row_dept)
        assert brief["department_id"] == d["id"]
        assert f_whole not in await mine(h_dept)
        r = await client.post("/efms/files", json={"subject": "Department level file", "category": "general", "initial_content": "x"}, headers=h_dept)
        f_dept = r.json()["id"]; files.append(f_dept)
        assert f_dept in await mine(h_dept) and f_whole not in await mine(h_dept)
        h_whole, _ = await switch(row_whole)
        assert f_whole in await mine(h_whole) and f_dept not in await mine(h_whole)

        # forwarding to the whole-establishment role lands in that role's Docket only
        r = await client.post("/efms/files", json={"subject": "Forward to whole role", "category": "general", "initial_content": "x"}, headers=H(sender))
        f_fwd = r.json()["id"]; files.append(f_fwd)
        r = await client.get("/admin/users", headers=H(sender))
        entries = [u for u in r.json() if u["id"] == uid]
        assert {x["user_role_id"] for x in entries} == {row_dept, row_whole}
        whole_entry = next(x for x in entries if x["user_role_id"] == row_whole)
        assert whole_entry["role_context"] == e["name"]                      # establishment only — no department in the label
        r = await client.post(f"/efms/files/{f_fwd}/route", json={"action": "forward", "to_user_id": uid, "to_role": "registrar",
                              "to_user_role_id": row_whole}, headers=H(sender))
        assert r.status_code == 200, r.text
        assert f_fwd in await docket(h_whole)
        h_dept, _ = await switch(row_dept)
        assert f_fwd not in await docket(h_dept)
    finally:
        await _files(db, files)
        for m in emails:
            await _drop_user(db, m)
        await _drop_org(db, [e["id"]], [d["id"]])


@pytest.mark.asyncio
async def test_an_establishment_with_whole_establishment_holders_cannot_be_deleted(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    e = await _estb(client, admin)
    emails = []
    try:
        r, m = await _api_user(client, admin, role="registrar", estb=e["id"], tag="holder", first="Holder"); assert r.status_code == 201
        emails.append(m); uid = r.json()["id"]
        r = await client.delete(f"/admin/establishments/{e['id']}", headers=H(admin))
        assert r.status_code == 409 and "Holder" in r.json()["detail"], r.text
        assert (await client.delete(f"/auth/admin/users/{uid}", headers=H(admin))).status_code == 204   # idle user
        emails.clear()
        assert (await client.delete(f"/admin/establishments/{e['id']}", headers=H(admin))).status_code == 204
    finally:
        for m in emails:
            await _drop_user(db, m)
        await _drop_org(db, [], [])


@pytest.mark.asyncio
async def test_bulk_import_accepts_establishment_only_rows(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    e = await _estb(client, admin)
    mails = [_mail("be0"), _mail("be1"), _mail("be2")]
    try:
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=["first_name", "last_name", "email", "mobile", "designation", "role", "establishment_id", "department_id", "temp_password"])
        w.writeheader()
        for i, (m, role) in enumerate(zip(mails, ["registrar", "registrar", "faculty"])):
            w.writerow({"first_name": f"E{i}", "last_name": "User", "email": m, "mobile": f"90001{i}3111", "designation": "Clerk",
                        "role": role, "establishment_id": e["id"], "department_id": "", "temp_password": ""})
        r = await client.post("/auth/admin/users/bulk", files={"file": ("u.csv", buf.getvalue().encode(), "text/csv")}, headers=H(admin))
        assert r.status_code == 200, r.text
        res = {x["email"]: x for x in r.json()["results"]}
        assert res[mails[0]]["status"] == "created"
        assert res[mails[1]]["status"] == "failed" and "already assigned to E0" in res[mails[1]]["error"]   # same one-person seat
        assert res[mails[2]]["status"] == "created"                                                        # a different role is fine
    finally:
        for m in mails:
            await _drop_user(db, m)
        await _drop_org(db, [e["id"]], [])
