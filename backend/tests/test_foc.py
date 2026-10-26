"""FOC (Fixation of Ceiling): Super Admin set-up (the project carries the
FOC in-charge; the Assistant Comptroller / Finance Officer / Vice Chancellor
are whoever holds the linked eFMS role), the in-charge's entries and
certificate, the DDO → AC → FO → VC chain (approve is final, reject needs a
remark and goes back to the in-charge, the VC cannot forward), dockets,
sanction documents and the approved-sheet PDF."""
import os
import uuid
from decimal import Decimal

import pytest
import pytest_asyncio
from sqlalchemy import delete, select

from app.api.v1.endpoints.foc import _doc_dir, build_foc_html, rupees_in_words
from app.core.config import settings
from app.models.foc import FocOfficer, FocProject, FocRoleLink, FocSheet
from app.models.user import SystemRole, UserRole
from tests.conftest import auth_headers as H


@pytest_asyncio.fixture
async def foc(db, users, roles):
    """Cleans up every FOC row the test creates (before `users` removes the
    people). Which eFMS role is the AC / FO / VC is a single setting in the
    shared dev database — the existing links are put back afterwards."""
    saved = [(l.role, l.efms_role_id) for l in (await db.execute(select(FocRoleLink))).scalars().all()]
    created = {"projects": [], "users": []}
    yield created
    await db.execute(delete(FocRoleLink))
    test_users = [u.id for u in users._created]
    sheets = (await db.execute(select(FocSheet).where(FocSheet.created_by.in_(test_users)))).scalars().all()
    for s in sheets:
        await db.refresh(s, ["lines"])
        for line in s.lines:
            if line.document_stored_name:
                try:
                    os.remove(os.path.join(_doc_dir(), line.document_stored_name))
                except OSError:
                    pass
    await db.execute(delete(FocSheet).where(FocSheet.created_by.in_(test_users)))
    await db.execute(delete(FocProject).where(FocProject.created_by.in_(test_users)))
    await db.execute(delete(FocOfficer).where(FocOfficer.user_id.in_(test_users)))
    await db.commit()
    for role, rid in saved:
        db.add(FocRoleLink(role=role, efms_role_id=rid))
    await db.commit()


async def _setup(client, users, roles):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    tag = uuid.uuid4().hex[:6]
    # The fixed offices are eFMS roles; FOC follows whoever holds them.
    efms = {k: await roles.make(f"t_{k}_{tag}") for k in ("ac", "fo", "vc")}
    people = {k: await users.make("registrar", first_name=k.title()) for k in ("incharge", "ddo1", "ddo2", "outsider")}
    for k in ("ac", "fo", "vc"):
        people[k] = await users.make(efms[k].name, first_name=k.upper())
    for foc_role, k in (("assistant_comptroller", "ac"), ("finance_officer", "fo"), ("vice_chancellor", "vc")):
        r = await client.put(f"/foc/officers/fixed/{foc_role}", headers=H(admin), json={"efms_role_id": str(efms[k].id)})
        assert r.status_code == 200 and r.json()["holder"]["id"] == str(people[k].id), r.text
    for who in ("ddo1", "ddo2"):
        r = await client.post("/foc/officers", headers=H(admin), json={"user_id": str(people[who].id)})
        assert r.status_code == 201, r.text
    r = await client.post("/foc/projects", headers=H(admin), json={
        "name": f"FOC Test Project {tag}", "funded_by": "Govt. of India", "funding_agency": "DBT",
        "incharge_id": str(people["incharge"].id), "project_type": "100%", "bank_name": "SBI", "bank_account_no": "1234",
        "fund_received_date": "2025-06-01",
    })
    assert r.status_code == 201, r.text
    project = r.json()
    assert project["incharge"]["id"] == str(people["incharge"].id)
    r = await client.post("/foc/sheets", headers=H(admin), json={
        "project_id": project["id"], "financial_year": "2025-2026", "name": "October 2025",
        "lines": [
            {"sub_head": "Salaries", "sanctioned_fund": "500000", "available_fund": "400000"},
            {"sub_head": "Consumables", "sanctioned_fund": "100000.50", "available_fund": "100000.50"},
        ],
    })
    assert r.status_code == 201, r.text
    people["_efms"] = efms
    return admin, people, project, r.json()


async def _fill_and_submit(client, sheet, incharge, ddo):
    lines = sheet["lines"]
    r = await client.put(f"/foc/sheets/{sheet['id']}/entries", headers=H(incharge), json=[
        {"line_id": lines[0]["id"], "amount_required": "15000", "purpose": "October salary", "sanction_order_no": "SO/1"},
        {"line_id": lines[1]["id"], "amount_required": "250.75", "remark": "Gloves"},
    ])
    assert r.status_code == 200, r.text
    r = await client.post(f"/foc/sheets/{sheet['id']}/submit", headers=H(incharge),
                          json={"ddo_user_id": str(ddo.id), "certified": True})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.asyncio
async def test_setup_is_super_admin_only(client, users, roles, foc):
    someone = await users.make("registrar")
    r = await client.post("/foc/projects", headers=H(someone), json={"name": "Nope"})
    assert r.status_code == 403
    r = await client.get("/foc/officers", headers=H(someone))
    assert r.status_code == 403
    me = (await client.get("/foc/me", headers=H(someone))).json()
    assert me["has_access"] is False


@pytest.mark.asyncio
async def test_sheet_validation(client, users, roles, foc):
    admin, people, project, sheet = await _setup(client, users, roles)
    base = {"project_id": project["id"], "financial_year": "2025-2026"}
    r = await client.post("/foc/sheets", headers=H(admin), json={**base, "name": "October 2025",
                                                                  "lines": [{"sub_head": "A", "sanctioned_fund": 1, "available_fund": 1}]})
    assert r.status_code == 409  # same project + FY + name
    r = await client.post("/foc/sheets", headers=H(admin), json={**base, "name": "Nov",
                                                                  "lines": [{"sub_head": "A", "sanctioned_fund": 10, "available_fund": 11}]})
    assert r.status_code == 400 and "available fund" in r.json()["detail"]
    r = await client.post("/foc/sheets", headers=H(admin), json={**base, "name": "Nov", "financial_year": "2025-2027",
                                                                  "lines": [{"sub_head": "A", "sanctioned_fund": 10, "available_fund": 1}]})
    assert r.status_code == 400
    r = await client.post("/foc/sheets", headers=H(admin), json={**base, "name": "Nov", "lines": []})
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_full_chain_reject_resubmit_and_approve(client, users, roles, foc):
    admin, p, project, sheet = await _setup(client, users, roles)
    inc = p["incharge"]
    sid = sheet["id"]

    me = (await client.get("/foc/me", headers=H(inc))).json()
    assert me["is_incharge"] and me["has_access"]
    assert [s["id"] for s in (await client.get("/foc/sheets/mine", headers=H(inc))).json()] == [sid]
    ddos = {d["id"] for d in (await client.get("/foc/ddos", headers=H(inc))).json()}
    assert {str(p["ddo1"].id), str(p["ddo2"].id)} <= ddos

    # The in-charge cannot ask for more than is available.
    r = await client.put(f"/foc/sheets/{sid}/entries", headers=H(inc),
                         json=[{"line_id": sheet["lines"][0]["id"], "amount_required": "400000.01"}])
    assert r.status_code == 400
    # Nor send without the certificate, to a non-DDO, or with nothing asked for.
    r = await client.post(f"/foc/sheets/{sid}/submit", headers=H(inc), json={"ddo_user_id": str(p["ddo1"].id), "certified": True})
    assert r.status_code == 400 and "amount required" in r.json()["detail"]
    await client.put(f"/foc/sheets/{sid}/entries", headers=H(inc), json=[{"line_id": sheet["lines"][0]["id"], "amount_required": "1"}])
    r = await client.post(f"/foc/sheets/{sid}/submit", headers=H(inc), json={"ddo_user_id": str(p["ddo1"].id), "certified": False})
    assert r.status_code == 400
    r = await client.post(f"/foc/sheets/{sid}/submit", headers=H(inc), json={"ddo_user_id": str(p["ac"].id), "certified": True})
    assert r.status_code == 400

    s = await _fill_and_submit(client, sheet, inc, p["ddo1"])
    assert s["status"] == "pending" and s["stage"] == "ddo" and s["holder"]["id"] == str(p["ddo1"].id)
    assert s["total_required"] == "15250.75"
    assert s["total_required_words"] == "Fifteen Thousand Two Hundred Fifty Rupees and Seventy Five Paise Only"
    assert s["can_edit"] is False
    # Locked for the in-charge while it is with the officers.
    r = await client.put(f"/foc/sheets/{sid}/entries", headers=H(inc), json=[{"line_id": sheet["lines"][0]["id"], "remark": "x"}])
    assert r.status_code == 403

    # The other DDO and outsiders cannot act or see it.
    assert (await client.post(f"/foc/sheets/{sid}/approve", headers=H(p["ddo2"]), json={})).status_code == 409
    assert (await client.get(f"/foc/sheets/{sid}", headers=H(p["outsider"]))).status_code == 403

    docket = (await client.get("/foc/docket", headers=H(p["ddo1"]))).json()
    row = next(r for r in docket if r["id"] == sid)
    assert row["box"] == "to_process" and row["dispatched_by"]["id"] == str(inc.id) and row["name"] == "October 2025"
    view = (await client.get(f"/foc/sheets/{sid}", headers=H(p["ddo1"]))).json()
    assert view["can_act"] and view["can_forward"] and view["forward_to_title"] == "Assistant Comptroller"

    # Reject needs a remark.
    assert (await client.post(f"/foc/sheets/{sid}/reject", headers=H(p["ddo1"]), json={"remark": "  "})).status_code == 400
    r = await client.post(f"/foc/sheets/{sid}/forward", headers=H(p["ddo1"]), json={"remark": "Checked"})
    assert r.status_code == 200 and r.json()["stage"] == "assistant_comptroller"
    assert (await client.post(f"/foc/sheets/{sid}/forward", headers=H(p["ddo1"]), json={})).status_code == 409

    r = await client.post(f"/foc/sheets/{sid}/reject", headers=H(p["ac"]), json={"remark": "Attach the sanction order"})
    assert r.status_code == 200 and r.json()["status"] == "rejected"
    back = (await client.get("/foc/docket", headers=H(inc))).json()
    assert next(r for r in back if r["id"] == sid)["box"] == "returned"
    view = (await client.get(f"/foc/sheets/{sid}", headers=H(inc))).json()
    assert view["can_edit"] and view["status_label"] == "Returned by Assistant Comptroller"
    assert view["movements"][-1]["remark"] == "Attach the sanction order"
    # The AC still sees it (history), but can no longer act on it.
    assert (await client.get(f"/foc/sheets/{sid}", headers=H(p["ac"]))).json()["can_act"] is False
    assert sid in {r["id"] for r in (await client.get("/foc/history", headers=H(p["ac"]))).json()}

    # Resubmitted — starts again at a DDO (another one this time).
    s = await _fill_and_submit(client, view, inc, p["ddo2"])
    assert s["stage"] == "ddo" and s["holder"]["id"] == str(p["ddo2"].id)
    for who, nxt in (("ddo2", "assistant_comptroller"), ("ac", "finance_officer"), ("fo", "vice_chancellor")):
        r = await client.post(f"/foc/sheets/{sid}/forward", headers=H(p[who]), json={})
        assert r.status_code == 200 and r.json()["stage"] == nxt, r.text
    # The Vice Chancellor is the last stage.
    r = await client.post(f"/foc/sheets/{sid}/forward", headers=H(p["vc"]), json={})
    assert r.status_code == 400
    assert (await client.get(f"/foc/sheets/{sid}", headers=H(p["vc"]))).json()["can_forward"] is False
    r = await client.post(f"/foc/sheets/{sid}/approve", headers=H(p["vc"]), json={})
    assert r.status_code == 200
    done = r.json()
    assert done["status"] == "approved" and done["status_label"] == "Approved by Vice Chancellor" and done["can_download"]

    # Approval is final: view and download only.
    view = (await client.get(f"/foc/sheets/{sid}", headers=H(inc))).json()
    assert view["can_edit"] is False and view["can_download"]
    assert (await client.put(f"/foc/sheets/{sid}/entries", headers=H(inc), json=[])).status_code == 403
    assert (await client.patch(f"/foc/sheets/{sid}", headers=H(admin), json={"name": "Changed"})).status_code == 409
    assert next(r for r in (await client.get("/foc/docket", headers=H(inc))).json() if r["id"] == sid)["box"] == "approved"
    r = await client.get(f"/foc/sheets/{sid}/pdf", headers=H(inc))
    assert r.status_code in (200, 503)  # 503 only where no PDF renderer is installed
    if r.status_code == 200:
        assert r.content[:4] == b"%PDF"
    assert (await client.get(f"/foc/sheets/{sid}/pdf", headers=H(p["outsider"]))).status_code == 403

    # It has been sent, so it is part of the record.
    assert (await client.delete(f"/foc/sheets/{sid}", headers=H(admin))).status_code == 409
    assert (await client.delete(f"/foc/projects/{project['id']}", headers=H(admin))).status_code == 409


@pytest.mark.asyncio
async def test_fixed_office_follows_the_efms_role(client, users, roles, foc, db):
    """A hand-over of the eFMS role carries the waiting FOC to the new holder."""
    admin, p, project, sheet = await _setup(client, users, roles)
    sid = sheet["id"]
    await _fill_and_submit(client, sheet, p["incharge"], p["ddo1"])
    await client.post(f"/foc/sheets/{sid}/forward", headers=H(p["ddo1"]), json={})
    assert sid in {r["id"] for r in (await client.get("/foc/docket", headers=H(p["ac"]))).json()}
    assert (await client.get("/foc/me", headers=H(p["ac"]))).json()["officer_titles"] == ["Assistant Comptroller"]

    # eFMS: the AC role moves to someone else.
    newcomer = await users.make("registrar", first_name="Newac")
    ac_role = p["_efms"]["ac"].name
    await db.execute(delete(UserRole).where(UserRole.user_id == p["ac"].id, UserRole.role == ac_role))
    db.add(UserRole(user_id=newcomer.id, role=ac_role))
    await db.commit()

    assert sid not in {r["id"] for r in (await client.get("/foc/docket", headers=H(p["ac"]))).json()}
    assert (await client.post(f"/foc/sheets/{sid}/forward", headers=H(p["ac"]), json={})).status_code == 409
    assert sid in {r["id"] for r in (await client.get("/foc/docket", headers=H(newcomer))).json()}
    view = (await client.get(f"/foc/sheets/{sid}", headers=H(newcomer))).json()
    assert view["can_act"] and view["holder"]["id"] == str(newcomer.id)
    r = await client.post(f"/foc/sheets/{sid}/forward", headers=H(newcomer), json={})
    assert r.status_code == 200 and r.json()["stage"] == "finance_officer"


@pytest.mark.asyncio
async def test_forward_needs_exactly_one_holder(client, users, roles, foc, db):
    admin, p, project, sheet = await _setup(client, users, roles)
    sid = sheet["id"]
    await _fill_and_submit(client, sheet, p["incharge"], p["ddo1"])
    # Two people hold the AC role.
    second = await users.make(p["_efms"]["ac"].name)
    r = await client.post(f"/foc/sheets/{sid}/forward", headers=H(p["ddo1"]), json={})
    assert r.status_code == 409 and "More than one person" in r.json()["detail"]
    officers = (await client.get("/foc/officers", headers=H(admin))).json()
    ac = next(f for f in officers["fixed"] if f["role"] == "assistant_comptroller")
    assert ac["holder"] is None and len(ac["holders"]) == 2 and ac["problem"]
    await db.execute(delete(UserRole).where(UserRole.user_id == second.id))
    await db.commit()
    # No eFMS role linked at all.
    await client.put("/foc/officers/fixed/assistant_comptroller", headers=H(admin), json={"efms_role_id": None})
    r = await client.post(f"/foc/sheets/{sid}/forward", headers=H(p["ddo1"]), json={})
    assert r.status_code == 409 and "No eFMS role is linked" in r.json()["detail"]


@pytest.mark.asyncio
async def test_project_incharge_change_moves_open_focs(client, users, roles, foc):
    admin, p, project, sheet = await _setup(client, users, roles)
    other = await users.make("registrar", first_name="Other")
    r = await client.patch(f"/foc/projects/{project['id']}", headers=H(admin), json={"incharge_id": str(other.id)})
    assert r.status_code == 200 and r.json()["incharge"]["id"] == str(other.id)
    assert [s["id"] for s in (await client.get("/foc/sheets/mine", headers=H(other))).json()] == [sheet["id"]]
    assert (await client.get("/foc/sheets/mine", headers=H(p["incharge"]))).json() == []
    # A project without an in-charge cannot get FOCs.
    r = await client.post("/foc/projects", headers=H(admin), json={"name": f"No incharge {uuid.uuid4().hex[:6]}"})
    r = await client.post("/foc/sheets", headers=H(admin), json={"project_id": r.json()["id"], "financial_year": "2025-2026",
                                                                 "name": "X", "lines": [{"sub_head": "A", "sanctioned_fund": 1, "available_fund": 1}]})
    assert r.status_code == 400 and "in-charge" in r.json()["detail"]


@pytest.mark.asyncio
async def test_super_admin_has_no_docket(client, users, roles, foc):
    admin, p, project, sheet = await _setup(client, users, roles)
    me = (await client.get("/foc/me", headers=H(admin))).json()
    assert me["has_access"] and me["has_docket"] is False
    assert (await client.get("/foc/me", headers=H(p["ddo1"]))).json()["has_docket"] is True
    assert (await client.get("/foc/me", headers=H(p["incharge"]))).json()["has_docket"] is True


@pytest.mark.asyncio
async def test_sanction_documents_are_private(client, users, roles, foc):
    admin, p, project, sheet = await _setup(client, users, roles)
    inc = p["incharge"]
    line = sheet["lines"][0]["id"]
    url = f"/foc/sheets/{sheet['id']}/lines/{line}/document"
    r = await client.post(url, headers=H(inc), files={"upload": ("order.exe", b"MZ", "application/octet-stream")})
    assert r.status_code == 400
    r = await client.post(url, headers=H(p["outsider"]), files={"upload": ("order.pdf", b"%PDF-1.4 x", "application/pdf")})
    assert r.status_code == 403
    r = await client.post(url, headers=H(inc), files={"upload": ("order.pdf", b"%PDF-1.4 x", "application/pdf")})
    assert r.status_code == 200, r.text
    stored = (await client.get(f"/foc/sheets/{sheet['id']}", headers=H(inc))).json()["lines"][0]["document"]
    assert stored["name"] == "order.pdf"
    # Kept outside the public /uploads folder.
    on_disk = [f for f in os.listdir(_doc_dir())]
    assert not any(f in os.listdir(os.path.abspath(settings.UPLOAD_DIR)) for f in on_disk if f.endswith(".pdf"))
    assert (await client.get(url, headers=H(inc))).content == b"%PDF-1.4 x"
    assert (await client.get(url, headers=H(p["outsider"]))).status_code == 403
    assert (await client.delete(url, headers=H(inc))).status_code == 204
    assert (await client.get(url, headers=H(inc))).status_code == 404


@pytest.mark.asyncio
async def test_draft_can_be_deleted_and_lines_edited(client, users, roles, foc):
    admin, p, project, sheet = await _setup(client, users, roles)
    lines = sheet["lines"]
    r = await client.patch(f"/foc/sheets/{sheet['id']}", headers=H(admin), json={"lines": [
        {"id": lines[0]["id"], "sub_head": "Salaries (revised)", "sanctioned_fund": "500000", "available_fund": "300000"},
        {"sub_head": "Travel", "sanctioned_fund": "20000", "available_fund": "20000"},
    ]})
    assert r.status_code == 200, r.text
    assert [ln["sub_head"] for ln in r.json()["lines"]] == ["Salaries (revised)", "Travel"]
    assert (await client.delete(f"/foc/sheets/{sheet['id']}", headers=H(admin))).status_code == 204


def test_rupees_in_words():
    assert rupees_in_words(Decimal("1513842")) == "Fifteen Lakh Thirteen Thousand Eight Hundred Forty Two Rupees Only"
    assert rupees_in_words(Decimal("0")) == "Zero Rupees Only"
    assert rupees_in_words(Decimal("12500000.50")) == "One Crore Twenty Five Lakh Rupees and Fifty Paise Only"
    assert rupees_in_words(Decimal("0.05")) == "Five Paise Only"


@pytest.mark.asyncio
async def test_pdf_html_uses_letterhead(client, users, roles, foc, db):
    admin, p, project, sheet = await _setup(client, users, roles)
    await _fill_and_submit(client, sheet, p["incharge"], p["ddo1"])
    await client.post(f"/foc/sheets/{sheet['id']}/approve", headers=H(p["ddo1"]), json={"remark": "OK"})
    from app.api.v1.endpoints.foc import _load_sheet
    s = await _load_sheet(db, uuid.UUID(sheet["id"]))
    html = build_foc_html(s)
    assert "ASSAM VETERINARY AND FISHERY UNIVERSITY" in html
    assert "Fixation of Ceiling" in html and "15,250.75" in html and "Approved by" in html
    assert "Fifteen Thousand Two Hundred Fifty Rupees" in html
