"""The same department (e.g. "Accounts") can exist in several
establishments, but only once in each. Existing department names can be
added to an establishment in one step; names it already has are skipped."""
import uuid
import pytest

from app.models.user import SystemRole
from tests.test_delete_guards_and_seats import _drop_org, _estb, H


@pytest.mark.asyncio
async def test_department_once_per_establishment_and_bulk_add(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    e1 = await _estb(client, admin)
    e2 = await _estb(client, admin)
    tag = uuid.uuid4().hex[:6]
    name = f"Accounts {tag}"
    created = []
    try:
        r = await client.post("/admin/departments", json={"name": name, "code": "ACCT", "establishment_id": e1["id"]}, headers=H(admin))
        assert r.status_code == 201, r.text
        created.append(r.json()["id"])
        # Same name again in the same establishment — refused, however it is spelt.
        r = await client.post("/admin/departments", json={"name": f"  {name.upper()} ", "code": "ACC2", "establishment_id": e1["id"]}, headers=H(admin))
        assert r.status_code == 409 and "already exists" in r.json()["detail"], r.text
        # The same name in another establishment is fine.
        r = await client.post("/admin/departments", json={"name": name, "code": "ACCT", "establishment_id": e2["id"]}, headers=H(admin))
        assert r.status_code == 201, r.text
        created.append(r.json()["id"])

        names = {n["name"]: n for n in (await client.get("/admin/departments/names", headers=H(admin))).json()}
        assert names[name]["count"] == 2 and names[name]["code"] == "ACCT"

        # Bulk add: one new name and one e2 already has.
        other = f"Library {tag}"
        r = await client.post("/admin/departments", json={"name": other, "code": "LIBR", "establishment_id": e1["id"]}, headers=H(admin))
        created.append(r.json()["id"])
        r = await client.post("/admin/departments/bulk", json={"establishment_id": e2["id"], "names": [other, name, other]}, headers=H(admin))
        assert r.status_code == 200, r.text
        assert r.json()["added"] == [other] and r.json()["skipped"] == [name]
        in_e2 = [d for d in (await client.get("/admin/departments/all", headers=H(admin))).json() if d["establishment_id"] == e2["id"]]
        assert sorted(d["name"] for d in in_e2) == sorted([name, other])
        assert next(d for d in in_e2 if d["name"] == other)["code"] == "LIBR"   # code copied across
        created += [d["id"] for d in in_e2 if d["id"] not in created]
        # Running it again adds nothing.
        r = await client.post("/admin/departments/bulk", json={"establishment_id": e2["id"], "names": [other, name]}, headers=H(admin))
        assert r.json()["added"] == [] and sorted(r.json()["skipped"]) == sorted([name, other])
        r = await client.post("/admin/departments/bulk", json={"establishment_id": e2["id"], "names": ["  "]}, headers=H(admin))
        assert r.status_code == 400
    finally:
        await _drop_org(db, [e1["id"], e2["id"]], created)
