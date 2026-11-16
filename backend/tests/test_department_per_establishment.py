"""Departments: the same department name may exist in several establishments
(once in each), but every department has its OWN code. Establishments and
departments are added in bulk from an Excel sheet with the columns
Establishment Name, Establishment Code, Department Name, Department Code."""
import io
import uuid

import openpyxl
import pytest
from sqlalchemy import delete, select

from app.models.organization import Department, Establishment
from app.models.user import SystemRole
from tests.test_delete_guards_and_seats import _drop_org, _estb, H

COLS = ["Establishment Name", "Establishment Code", "Department Name", "Department Code"]
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _xlsx(rows, header=COLS) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(header)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


async def _upload(client, admin, content: bytes, name="depts.xlsx", ctype=XLSX):
    return await client.post("/admin/departments/bulk", files={"file": (name, content, ctype)}, headers=H(admin))


async def _cleanup(db, tag):
    estbs = (await db.execute(select(Establishment).where(Establishment.name.like(f"%{tag}%")))).scalars().all()
    ids = [e.id for e in estbs]
    if ids:
        await db.execute(delete(Department).where(Department.establishment_id.in_(ids)))
        await db.execute(delete(Establishment).where(Establishment.id.in_(ids)))
        await db.commit()


@pytest.mark.asyncio
async def test_single_create_rules(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    e1, e2 = await _estb(client, admin), await _estb(client, admin)
    tag, created = uuid.uuid4().hex[:5].upper(), []
    try:
        r = await client.post("/admin/departments", json={"name": f"Accounts {tag}", "code": f"A{tag}", "establishment_id": e1["id"]}, headers=H(admin))
        assert r.status_code == 201, r.text
        created.append(r.json()["id"])
        # same name again in the same establishment (any spelling) — refused
        r = await client.post("/admin/departments", json={"name": f"  accounts {tag.lower()} ", "code": f"B{tag}", "establishment_id": e1["id"]}, headers=H(admin))
        assert r.status_code == 409 and "already exists" in r.json()["detail"]
        # same name in another establishment with its OWN code — fine
        r = await client.post("/admin/departments", json={"name": f"Accounts {tag}", "code": f"C{tag}", "establishment_id": e2["id"]}, headers=H(admin))
        assert r.status_code == 201, r.text
        created.append(r.json()["id"])
        # the same code on a different department — refused, whatever the case
        r = await client.post("/admin/departments", json={"name": f"Library {tag}", "code": f"a{tag}".lower(), "establishment_id": e2["id"]}, headers=H(admin))
        assert r.status_code == 409 and "own code" in r.json()["detail"]
    finally:
        await _drop_org(db, [e1["id"], e2["id"]], created)


@pytest.mark.asyncio
async def test_excel_template_downloads_and_reads_back(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    r = await client.get("/admin/departments/bulk/template", headers=H(admin))
    assert r.status_code == 200 and "spreadsheetml" in r.headers["content-type"]
    wb = openpyxl.load_workbook(io.BytesIO(r.content))
    assert [c.value for c in wb["Departments"][1]] == COLS
    assert "How to fill" in wb.sheetnames
    assert (await client.get("/admin/departments/bulk/template", headers=H(await users.make("registrar")))).status_code == 403


@pytest.mark.asyncio
async def test_bulk_upload_creates_skips_and_reports(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    tag = uuid.uuid4().hex[:5].upper()
    A, B = f"College A {tag}", f"College B {tag}"
    try:
        rows = [
            [A, f"A{tag}", "Accounts Section", f"AA{tag}"],           # new establishment + department
            [A, f"A{tag}", "Library", f"AL{tag}"],                     # existing establishment, new department
            [B, f"B{tag}", "Accounts Section", f"BA{tag}"],           # same department name, own code
            [A, "", "accounts section", f"X1{tag}"],                   # already there (case-insensitive) → skipped
            [B, f"B{tag}", "Hostel", f"AA{tag.lower()}"],              # code already used (any case) → failed
            [f"College C {tag}", "", "Workshop", f"CW{tag}"],          # new establishment without a code → failed
            [B, f"WRONG{tag}", "Canteen", f"BC{tag}"],                 # establishment code differs → failed
            [B, f"B{tag}", "", f"BX{tag}"],                            # no department name → failed
            [None, None, None, None],                                  # blank row ignored
            [A, f"A{tag}", "Store", 12345],                            # numeric code stays "12345"
        ]
        r = await _upload(client, admin, _xlsx(rows))
        assert r.status_code == 200, r.text
        body = r.json()
        by_row = {x["row"]: x for x in body["results"]}
        assert [by_row[n]["status"] for n in (2, 3, 4, 5, 6, 7, 8, 9)] == ["created", "created", "created", "skipped", "failed", "failed", "failed", "failed"]
        assert by_row[11]["status"] == "created"
        assert "already used" in by_row[6]["note"] and "Establishment Code is required" in by_row[7]["note"]
        assert "already exists with code" in by_row[8]["note"] and "Missing" in by_row[9]["note"]
        assert (body["total"], body["created"], body["skipped"], body["failed"], body["establishments_created"]) == (9, 4, 1, 4, 2)

        all_depts = (await client.get("/admin/departments/all", headers=H(admin))).json()
        estbs = {e["name"]: e["id"] for e in (await client.get("/admin/establishments/all", headers=H(admin))).json()}
        mine = {(d["establishment_id"], d["name"]): d["code"] for d in all_depts if d["establishment_id"] in (estbs[A], estbs[B])}
        assert mine[(estbs[A], "Accounts Section")] == f"AA{tag}" and mine[(estbs[B], "Accounts Section")] == f"BA{tag}"
        assert mine[(estbs[A], "Store")] == "12345"
        assert (estbs[B], "Hostel") not in mine and (estbs[B], "Canteen") not in mine

        # Uploading the same sheet again changes nothing.
        r = await _upload(client, admin, _xlsx(rows[:3]))
        assert r.json()["created"] == 0 and r.json()["skipped"] + r.json()["failed"] == 3
    finally:
        await _cleanup(db, tag)


@pytest.mark.asyncio
async def test_bulk_upload_rejects_bad_files(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    r = await _upload(client, admin, b"not excel", name="x.xlsx")
    assert r.status_code == 400
    r = await _upload(client, admin, b"x", name="x.pdf", ctype="application/pdf")
    assert r.status_code == 400 and ".xlsx" in r.json()["detail"]
    r = await _upload(client, admin, _xlsx([["a", "b"]], header=["Establishment Name", "Department Name"]))
    assert r.status_code == 400 and "Establishment Code" in r.json()["detail"]
    r = await _upload(client, admin, _xlsx([]))
    assert r.status_code == 400 and "no data rows" in r.json()["detail"]
    csv_bytes = ("Establishment Name,Establishment Code,Department Name,Department Code\n"
                 f"CsvCollege {uuid.uuid4().hex[:5]},CSV1,Dept One,CSVD{uuid.uuid4().hex[:5]}\n").encode()
    try:
        r = await _upload(client, admin, csv_bytes, name="d.csv", ctype="text/csv")
        assert r.status_code == 200 and r.json()["created"] == 1, r.text
    finally:
        await _cleanup(db, "CsvCollege")
    assert (await _upload(client, await users.make("registrar"), _xlsx([]))).status_code == 403
