"""Admin can fix spelling mistakes: edit establishments, departments,
categories and priority labels — with the same duplicate rules as creating
them, and files following a renamed category."""
import uuid

import pytest
from sqlalchemy import delete, select

from app.models.admin import FileCategory, FilePriority
from app.models.efms import EfmsFile
from app.models.user import SystemRole
from tests.conftest import auth_headers as H
from tests.test_delete_guards_and_seats import _drop_org, _estb


@pytest.mark.asyncio
async def test_edit_establishment_and_department(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    e1, e2 = await _estb(client, admin), await _estb(client, admin)
    tag = uuid.uuid4().hex[:5].upper()
    depts = []
    try:
        # establishment: rename + recode; duplicates refused
        r = await client.patch(f"/admin/establishments/{e1['id']}", json={"name": f"  College Of Vet {tag} ", "code": f"CV{tag}"}, headers=H(admin))
        assert r.status_code == 200 and r.json()["name"] == f"College Of Vet {tag}" and r.json()["code"] == f"CV{tag}"
        r = await client.patch(f"/admin/establishments/{e2['id']}", json={"name": f"college of vet {tag}"}, headers=H(admin))
        assert r.status_code == 409 and "already called" in r.json()["detail"]
        r = await client.patch(f"/admin/establishments/{e2['id']}", json={"code": f"cv{tag}".lower()}, headers=H(admin))
        assert r.status_code == 409 and "already used" in r.json()["detail"]
        assert (await client.patch(f"/admin/establishments/{e2['id']}", json={"name": "  "}, headers=H(admin))).status_code == 400

        mk = lambda n, c, e: client.post("/admin/departments", json={"name": n, "code": c, "establishment_id": e["id"]}, headers=H(admin))
        for n, c, e in ((f"Acounts {tag}", f"AC{tag}", e1), (f"Library {tag}", f"LB{tag}", e1), (f"Accounts {tag}", f"AX{tag}", e2)):
            r = await mk(n, c, e); assert r.status_code == 201, r.text; depts.append(r.json()["id"])
        # fix the spelling
        r = await client.patch(f"/admin/departments/{depts[0]}", json={"name": f"Accounts {tag}"}, headers=H(admin))
        assert r.status_code == 200 and r.json()["name"] == f"Accounts {tag}" and r.json()["code"] == f"AC{tag}"
        # a name the establishment already has
        r = await client.patch(f"/admin/departments/{depts[1]}", json={"name": f"accounts {tag}"}, headers=H(admin))
        assert r.status_code == 409 and "already has" in r.json()["detail"]
        # a code that belongs to a different department name
        r = await client.patch(f"/admin/departments/{depts[1]}", json={"code": f"AC{tag}"}, headers=H(admin))
        assert r.status_code == 409 and "already belongs" in r.json()["detail"]
        # the same code for the same department name elsewhere is fine
        r = await client.patch(f"/admin/departments/{depts[2]}", json={"code": f"AC{tag}"}, headers=H(admin))
        assert r.status_code == 200 and r.json()["code"] == f"AC{tag}"
        assert (await client.patch(f"/admin/departments/{depts[2]}", json={"code": " "}, headers=H(admin))).status_code == 400
        # only the Super Admin
        assert (await client.patch(f"/admin/departments/{depts[2]}", json={"name": "x"}, headers=H(await users.make("registrar")))).status_code == 403
    finally:
        await _drop_org(db, [e1["id"], e2["id"]], depts)


@pytest.mark.asyncio
async def test_rename_category_moves_its_files_and_priority_label_only(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    officer = await users.make(SystemRole.EFMS_OFFICER)
    tag = uuid.uuid4().hex[:5]
    cats, file_id = [], None
    try:
        for n in (f"Finanse {tag}", f"Works {tag}"):
            r = await client.post("/admin/categories", json={"name": n}, headers=H(admin)); assert r.status_code == 201; cats.append(r.json()["id"])
        r = await client.post("/efms/files", json={"subject": f"Budget file {tag}", "category": f"Finanse {tag}"}, headers=H(officer))
        assert r.status_code == 201, r.text
        file_id = r.json()["id"]
        r = await client.patch(f"/admin/categories/{cats[0]}", json={"name": f"Finance {tag}"}, headers=H(admin))
        assert r.status_code == 200 and r.json()["name"] == f"Finance {tag}"
        f = (await db.execute(select(EfmsFile).where(EfmsFile.id == uuid.UUID(file_id)).execution_options(populate_existing=True))).scalar_one()
        assert f.category == f"Finance {tag}"
        r = await client.patch(f"/admin/categories/{cats[1]}", json={"name": f"FINANCE {tag}"}, headers=H(admin))
        assert r.status_code == 409

        pri = (await db.execute(select(FilePriority).order_by(FilePriority.name))).scalars().first()
        old_label, old_name = pri.label, pri.name
        try:
            r = await client.patch(f"/admin/priorities/{pri.id}", json={"label": "  Very Normal  "}, headers=H(admin))
            assert r.status_code == 200 and r.json()["label"] == "Very Normal" and r.json()["name"] == old_name
            assert (await client.patch(f"/admin/priorities/{pri.id}", json={"label": ""}, headers=H(admin))).status_code == 400
        finally:
            await client.patch(f"/admin/priorities/{pri.id}", json={"label": old_label}, headers=H(admin))
    finally:
        if file_id:
            f = await db.get(EfmsFile, uuid.UUID(file_id))
            if f:
                await db.delete(f)
        await db.execute(delete(FileCategory).where(FileCategory.id.in_([uuid.UUID(c) for c in cats])))
        await db.commit()
