"""An extra role can carry its own (optional) designation — e.g. a
Professor who is also the Head of Department. Blank means the person's own
designation is used."""
import pytest

from app.models.user import SystemRole
from tests.conftest import auth_headers
from tests.test_delete_guards_and_seats import _api_user, _dept, _drop_org, _drop_user, _estb, H


@pytest.mark.asyncio
async def test_extra_role_designation_is_saved_shown_and_optional(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    viewer = await users.make(SystemRole.EFMS_OFFICER, first_name="Viewer")
    e = await _estb(client, admin)
    d = await _dept(client, admin, e["id"])
    emails = []
    try:
        r, m = await _api_user(client, admin, role="faculty", estb=e["id"], dept=d["id"], tag="desig"); assert r.status_code == 201
        emails.append(m)
        uid = r.json()["id"]
        main = {"role": "faculty", "establishment_id": e["id"], "department_id": d["id"]}
        r = await client.patch(f"/auth/admin/users/{uid}", json={"roles": [
            main, {"role": "hod", "establishment_id": e["id"], "department_id": d["id"], "designation": "  Head of Department  "}]},
            headers=H(admin))
        assert r.status_code == 200, r.text
        got = {x["role"]: x["designation"] for x in r.json()["roles"]}
        assert got == {"faculty": None, "hod": "Head of Department"}   # trimmed; main role unchanged
        assert r.json()["designation"] == "Clerk"                       # the person's own designation stays

        # The recipient picker shows each role with its own designation.
        picker = (await client.get("/admin/users", headers=auth_headers(viewer))).json()
        mine = {x["role"]: x["designation"] for x in picker if x["id"] == uid}
        assert mine == {"faculty": "Clerk", "hod": "Head of Department"}

        # Changing it, then clearing it (blank → the person's own designation).
        r = await client.patch(f"/auth/admin/users/{uid}", json={"roles": [
            main, {"role": "hod", "establishment_id": e["id"], "department_id": d["id"], "designation": "HoD, Animal Nutrition"}]},
            headers=H(admin))
        assert {x["role"]: x["designation"] for x in r.json()["roles"]}["hod"] == "HoD, Animal Nutrition"
        r = await client.patch(f"/auth/admin/users/{uid}", json={"roles": [
            main, {"role": "hod", "establishment_id": e["id"], "department_id": d["id"], "designation": ""}]},
            headers=H(admin))
        assert {x["role"]: x["designation"] for x in r.json()["roles"]}["hod"] is None
        picker = (await client.get("/admin/users", headers=auth_headers(viewer))).json()
        assert {x["role"]: x["designation"] for x in picker if x["id"] == uid}["hod"] == "Clerk"

        # Too long is refused.
        r = await client.patch(f"/auth/admin/users/{uid}", json={"roles": [
            main, {"role": "hod", "establishment_id": e["id"], "department_id": d["id"], "designation": "x" * 101}]},
            headers=H(admin))
        assert r.status_code == 422
    finally:
        for m in emails:
            await _drop_user(db, m)
        await _drop_org(db, [e["id"]], [d["id"]])
