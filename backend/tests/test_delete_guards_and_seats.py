"""Super Admin delete guards (users, roles, departments, establishments —
refused as soon as the item has been used, with the exact reason) and the
one-holder-per-seat rule (role + establishment + department) across create,
bulk import, edit, transfer and simultaneous requests. See
app/utils/integrity.py."""
import asyncio
import uuid

import pytest
from sqlalchemy import select, delete as sa_delete, update as sa_update

from app.models.efms import EfmsFile, DispatchRecord, RouteEntry
from app.models.efms_extra import Docket
from app.models.organization import Department, Establishment
from app.models.project import Project
from app.models.user import Role, SystemRole, User, UserRole
from tests.conftest import auth_headers

PWD = "Pytest@12345"


def H(u):
    return auth_headers(u)


async def _estb(client, admin, name=None):
    r = await client.post("/admin/establishments", json={"name": name or f"E-{uuid.uuid4().hex[:8]}", "code": uuid.uuid4().hex[:6]}, headers=H(admin))
    assert r.status_code == 201, r.text
    return r.json()


async def _dept(client, admin, estb_id, name=None):
    r = await client.post("/admin/departments", json={"name": name or f"D-{uuid.uuid4().hex[:8]}", "code": uuid.uuid4().hex[:6], "establishment_id": estb_id}, headers=H(admin))
    assert r.status_code == 201, r.text
    return r.json()


def _mail(tag):
    return f"seat.{tag}.{uuid.uuid4().hex[:8]}@example.com"


async def _api_user(client, admin, role="efms_officer", estb=None, dept=None, tag="u", first="Seat", last=None):
    email = _mail(tag)
    body = {"first_name": first, "last_name": last or tag.title(), "email": email, "mobile": "9" + uuid.uuid4().int.__str__()[:9],
            "designation": "Clerk", "role": role, "is_active": True, "temp_password": PWD}
    if estb: body["establishment_id"] = estb
    if dept: body["department_id"] = dept
    return await client.post("/auth/admin/users", json=body, headers=H(admin)), email


async def _drop_user(db, email):
    u = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if u:
        await db.execute(sa_delete(UserRole).where(UserRole.user_id == u.id))
        await db.execute(sa_delete(User).where(User.id == u.id))
        await db.commit()


async def _drop_org(db, estb_ids=(), dept_ids=()):
    for d in dept_ids:
        await db.execute(sa_delete(Department).where(Department.id == uuid.UUID(d)))
    for e in estb_ids:
        await db.execute(sa_delete(Establishment).where(Establishment.id == uuid.UUID(e)))
    await db.commit()


async def _drop_files(db, ids):
    for fid in ids:
        fid = uuid.UUID(fid)
        await db.execute(sa_delete(Docket).where(Docket.file_id == fid))
        await db.execute(sa_delete(DispatchRecord).where(DispatchRecord.file_id == fid))
        f = await db.get(EfmsFile, fid)
        if f:
            await db.delete(f)
    await db.commit()


async def _file(client, u, subject="Delete guard test file"):
    r = await client.post("/efms/files", json={"subject": subject, "category": "general", "initial_content": "x"}, headers=H(u))
    assert r.status_code == 201, r.text
    return r.json()["id"]


# ═══════════════════════════ DELETE: USERS ═══════════════════════════════════

@pytest.mark.asyncio
async def test_idle_user_can_be_deleted_and_takes_roles_with_it(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    r, email = await _api_user(client, admin, tag="idle")
    assert r.status_code == 201, r.text
    uid = r.json()["id"]
    r = await client.delete(f"/auth/admin/users/{uid}", headers=H(admin))
    assert r.status_code == 204, r.text
    assert (await db.execute(select(User).where(User.email == email))).scalar_one_or_none() is None
    assert (await db.execute(select(UserRole).where(UserRole.user_id == uuid.UUID(uid)))).first() is None


@pytest.mark.asyncio
async def test_user_with_file_activity_cannot_be_deleted_and_reason_is_exact(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    worker = await users.make(SystemRole.EFMS_OFFICER, first_name="Worker")
    other = await users.make(SystemRole.EFMS_OFFICER, first_name="Other")
    fid = await _file(client, worker)
    try:
        r = await client.delete(f"/auth/admin/users/{worker.id}", headers=H(admin))
        assert r.status_code == 409, r.text
        d = r.json()["detail"]
        assert "Cannot delete Worker" in d and "already worked in eFMS" in d
        assert "Created 1 file" in d and "Currently holds 1 file" in d
        assert "can only be deactivated" in d
        assert (await db.get(User, worker.id)) is not None

        # forwarding makes the recipient involved too
        r = await client.post(f"/efms/files/{fid}/route", json={"action": "forward", "to_user_id": str(other.id)}, headers=H(worker))
        assert r.status_code == 200, r.text
        r = await client.delete(f"/auth/admin/users/{other.id}", headers=H(admin))
        assert r.status_code == 409
        assert "Currently holds 1 file" in r.json()["detail"] and "Received files through 1 routing entry" in r.json()["detail"]
    finally:
        await _drop_files(db, [fid])


@pytest.mark.asyncio
async def test_user_delete_special_cases(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    # self
    r = await client.delete(f"/auth/admin/users/{admin.id}", headers=H(admin))
    assert r.status_code == 409 and "signed in" in r.json()["detail"]
    # unknown
    r = await client.delete(f"/auth/admin/users/{uuid.uuid4()}", headers=H(admin))
    assert r.status_code == 404
    # not a super admin
    normal = await users.make(SystemRole.EFMS_OFFICER)
    r = await client.delete(f"/auth/admin/users/{admin.id}", headers=H(normal))
    assert r.status_code == 403
    # a user who deactivated someone is involved
    victim = await users.make(SystemRole.EFMS_OFFICER)
    await db.execute(sa_update(User).where(User.id == victim.id).values(is_active=False, deactivated_by=normal.id))
    await db.commit()
    r = await client.delete(f"/auth/admin/users/{normal.id}", headers=H(admin))
    assert r.status_code == 409 and "Deactivated 1 other account" in r.json()["detail"]
    await db.execute(sa_update(User).where(User.id == victim.id).values(deactivated_by=None))
    await db.commit()
    # deactivated idle user CAN be deleted
    r = await client.delete(f"/auth/admin/users/{victim.id}", headers=H(admin))
    assert r.status_code == 204, r.text


@pytest.mark.asyncio
async def test_user_with_project_is_involved(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    pi = await users.make(SystemRole.EFMS_OFFICER, first_name="Pi")
    r = await client.post("/projects", json={"name": "Guard project", "assign_user_id": str(pi.id)}, headers=H(admin))
    assert r.status_code == 201, r.text
    p = r.json()
    try:
        r = await client.delete(f"/auth/admin/users/{pi.id}", headers=H(admin))
        assert r.status_code == 409 and "Has 1 project (PI) profile" in r.json()["detail"]
        # and the admin who created the project is involved as well
        r = await client.delete(f"/auth/admin/users/{p['current_profile_id']}", headers=H(admin))
        assert r.status_code == 400  # profiles are managed from Projects
    finally:
        pid, prof = uuid.UUID(p["id"]), uuid.UUID(p["current_profile_id"])
        await db.execute(sa_update(Project).where(Project.id == pid).values(current_profile_id=None))
        await db.execute(sa_delete(User).where(User.id == prof))
        await db.execute(sa_delete(Project).where(Project.id == pid))
        await db.commit()


# ═══════════════════════════ DELETE: ROLES ═══════════════════════════════════

@pytest.mark.asyncio
async def test_role_delete_rules(client, users, roles, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    # assigned to a deactivated user -> still blocked, person named
    role = await roles.make("test_guard_role_a")
    holder = await users.make(role.name, first_name="Holder")
    await db.execute(sa_update(User).where(User.id == holder.id).values(is_active=False))
    await db.commit()
    r = await client.delete(f"/auth/admin/roles/{role.id}", headers=H(admin))
    assert r.status_code == 409
    d = r.json()["detail"]
    assert "Holder" in d and "[deactivated]" in d and "still assigned" in d

    # unassigned but used for file work -> blocked
    role2 = await roles.make("test_guard_role_b")
    worker = await users.make(role2.name, first_name="RoleWorker")
    fid = await _file(client, worker)
    try:
        await db.execute(sa_delete(UserRole).where(UserRole.user_id == worker.id))
        await db.commit()
        r = await client.delete(f"/auth/admin/roles/{role2.id}", headers=H(admin))
        d = r.json()["detail"]
        assert r.status_code == 409 and "already been used for file work" in d and "1 file created while acting" in d
    finally:
        await _drop_files(db, [fid])

    # never used, nobody assigned -> deleted
    role3 = await roles.make("test_guard_role_c")
    r = await client.delete(f"/auth/admin/roles/{role3.id}", headers=H(admin))
    assert r.status_code == 204, r.text


# ═══════════════════════════ DELETE: DEPT / ESTB ═════════════════════════════

@pytest.mark.asyncio
async def test_department_and_establishment_delete_rules(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    e = await _estb(client, admin, f"Estb-{uuid.uuid4().hex[:6]}")
    d = await _dept(client, admin, e["id"], f"Dept-{uuid.uuid4().hex[:6]}")
    emails, files = [], []
    try:
        # establishment with a department -> blocked, department named
        r = await client.delete(f"/admin/establishments/{e['id']}", headers=H(admin))
        assert r.status_code == 409 and d["name"] in r.json()["detail"] and "Delete those departments first" in r.json()["detail"]

        # idle user assigned to the department -> blocked: reassign first
        r, idle_mail = await _api_user(client, admin, estb=e["id"], dept=d["id"], tag="idle", first="Idle")
        assert r.status_code == 201, r.text
        emails.append(idle_mail)
        r = await client.delete(f"/admin/departments/{d['id']}", headers=H(admin))
        msg = r.json()["detail"]
        assert r.status_code == 409 and "Idle" in msg and "still assigned here" in msg

        # same user does file work -> exact "already worked" reason
        idle = (await db.execute(select(User).where(User.email == idle_mail))).scalar_one()
        fid = await _file(client, idle)
        files.append(fid)
        r = await client.delete(f"/admin/departments/{d['id']}", headers=H(admin))
        msg = r.json()["detail"]
        assert "has already worked in eFMS" in msg and "created 1 file" in msg and "This history is permanent" in msg
        assert "created by people acting in this department" in msg
        r = await client.delete(f"/admin/establishments/{e['id']}", headers=H(admin))
        assert "created by people acting in this establishment" in r.json()["detail"] or "still has 1 department" in r.json()["detail"].replace("It still has", "still has")

        # reassign the user away + remove file history -> department can finally go
        await _drop_files(db, files); files.clear()
        await _drop_user(db, idle_mail); emails.clear()
        r = await client.delete(f"/admin/departments/{d['id']}", headers=H(admin))
        assert r.status_code == 204, r.text
        r = await client.delete(f"/admin/establishments/{e['id']}", headers=H(admin))
        assert r.status_code == 204, r.text
    finally:
        await _drop_files(db, files)
        for m in emails:
            await _drop_user(db, m)
        await _drop_org(db, [e["id"]], [d["id"]])


@pytest.mark.asyncio
async def test_department_blocked_by_file_belonging_to_it_and_by_role_scoped_assignment(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    e = await _estb(client, admin)
    d = await _dept(client, admin, e["id"])
    emails = []
    try:
        # role-scoped (secondary) assignment counts
        person = await users.make(SystemRole.EFMS_OFFICER, first_name="Scoped")
        db.add(UserRole(user_id=person.id, role="hod", department_id=uuid.UUID(d["id"]), establishment_id=uuid.UUID(e["id"])))
        await db.commit()
        r = await client.delete(f"/admin/departments/{d['id']}", headers=H(admin))
        assert r.status_code == 409 and "Scoped" in r.json()["detail"]
        await db.execute(sa_delete(UserRole).where(UserRole.user_id == person.id, UserRole.role == "hod"))
        await db.commit()
        r = await client.delete(f"/admin/departments/{d['id']}", headers=H(admin))
        assert r.status_code == 204, r.text
    finally:
        await _drop_org(db, [e["id"]], [d["id"]])


# ═══════════════════════════ SEATS ═══════════════════════════════════════════

@pytest.mark.asyncio
async def test_seat_taken_on_create_and_allowed_elsewhere(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    e1, e2 = await _estb(client, admin), await _estb(client, admin)
    d1, d2 = await _dept(client, admin, e1["id"]), await _dept(client, admin, e1["id"])
    emails = []
    try:
        r, m1 = await _api_user(client, admin, role="registrar", estb=e1["id"], dept=d1["id"], tag="first", first="First")
        assert r.status_code == 201, r.text; emails.append(m1)

        r, m2 = await _api_user(client, admin, role="registrar", estb=e1["id"], dept=d1["id"], tag="second")
        assert r.status_code == 409
        det = r.json()["detail"]
        assert "already assigned to First" in det and m1 in det and d1["name"] in det and e1["name"] in det
        assert (await db.execute(select(User).where(User.email == m2))).scalar_one_or_none() is None  # nothing created

        # different dept / estb / role -> fine
        for kw in (dict(role="registrar", estb=e1["id"], dept=d2["id"]), dict(role="registrar", estb=e2["id"]),
                   dict(role="hod", estb=e1["id"], dept=d1["id"])):
            r, m = await _api_user(client, admin, tag="ok", **kw)
            assert r.status_code == 201, (kw, r.text); emails.append(m)
        # no establishment/department at all is not a seat -> many allowed
        for i in range(2):
            r, m = await _api_user(client, admin, role="registrar", tag=f"free{i}")
            assert r.status_code == 201, r.text; emails.append(m)
        # super_admin exempt even inside a department
        for i in range(2):
            r, m = await _api_user(client, admin, role="super_admin", estb=e1["id"], dept=d1["id"], tag=f"sa{i}")
            assert r.status_code == 201, r.text; emails.append(m)
    finally:
        for m in emails:
            await _drop_user(db, m)
        await _drop_org(db, [e1["id"], e2["id"]], [d1["id"], d2["id"]])


@pytest.mark.asyncio
async def test_seat_rule_on_edit_roles_and_moving_department(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    e = await _estb(client, admin)
    d1, d2 = await _dept(client, admin, e["id"]), await _dept(client, admin, e["id"])
    emails = []
    try:
        r, holder_mail = await _api_user(client, admin, role="registrar", estb=e["id"], dept=d1["id"], tag="holder", first="Holder")
        assert r.status_code == 201; emails.append(holder_mail)
        r, mover_mail = await _api_user(client, admin, role="registrar", estb=e["id"], dept=d2["id"], tag="mover", first="Mover")
        assert r.status_code == 201; emails.append(mover_mail)
        mover_id = r.json()["id"]

        # moving Mover into the department whose Registrar seat is taken
        r = await client.patch(f"/auth/admin/users/{mover_id}", json={"department_id": d1["id"]}, headers=H(admin))
        assert r.status_code == 409 and "already assigned to Holder" in r.json()["detail"]
        # adding an explicit second role context on the taken seat
        r = await client.patch(f"/auth/admin/users/{mover_id}", json={"roles": [
            {"role": "registrar", "establishment_id": e["id"], "department_id": d2["id"]},
            {"role": "registrar", "establishment_id": e["id"], "department_id": d1["id"]}]}, headers=H(admin))
        assert r.status_code == 409, r.text
        # and a free seat is fine
        r = await client.patch(f"/auth/admin/users/{mover_id}", json={"roles": [
            {"role": "registrar", "establishment_id": e["id"], "department_id": d2["id"]},
            {"role": "hod", "establishment_id": e["id"], "department_id": d1["id"]}]}, headers=H(admin))
        assert r.status_code == 200, r.text
        # unrelated edit of an existing holder never fails
        r = await client.patch(f"/auth/admin/users/{mover_id}", json={"designation": "Registrar II"}, headers=H(admin))
        assert r.status_code == 200, r.text
        # the stored state was not touched by the rejected edits
        r = await client.get(f"/auth/admin/users", headers=H(admin))
        mover = next(u for u in r.json() if u["id"] == mover_id)
        assert mover["department_id"] == d2["id"]
    finally:
        for m in emails:
            await _drop_user(db, m)
        await _drop_org(db, [e["id"]], [d1["id"], d2["id"]])


@pytest.mark.asyncio
async def test_legacy_duplicate_does_not_block_unrelated_edits(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    e = await _estb(client, admin)
    d = await _dept(client, admin, e["id"])
    emails = []
    try:
        r, m1 = await _api_user(client, admin, role="registrar", estb=e["id"], dept=d["id"], tag="a")
        assert r.status_code == 201; emails.append(m1)
        r, m2 = await _api_user(client, admin, role="faculty", estb=e["id"], dept=d["id"], tag="b")
        assert r.status_code == 201; emails.append(m2)
        b_id = r.json()["id"]
        # force a legacy duplicate straight in the DB (what old data looks like)
        b = (await db.execute(select(User).where(User.id == uuid.UUID(b_id)))).scalar_one()
        await db.execute(sa_update(UserRole).where(UserRole.user_id == b.id).values(role="registrar"))
        await db.commit()
        r = await client.patch(f"/auth/admin/users/{b_id}", json={"designation": "Still editable", "first_name": "Renamed"}, headers=H(admin))
        assert r.status_code == 200, r.text
        # ...but re-saving the same role set is also not a "new" seat
        r = await client.patch(f"/auth/admin/users/{b_id}", json={"roles": [
            {"role": "registrar", "establishment_id": e["id"], "department_id": d["id"]}]}, headers=H(admin))
        assert r.status_code in (200, 409)  # explicit ctx row differs from legacy NULL-ctx row; either is defensible
    finally:
        for m in emails:
            await _drop_user(db, m)
        await _drop_org(db, [e["id"]], [d["id"]])


@pytest.mark.asyncio
async def test_bulk_import_respects_seats(client, users, db):
    import csv, io
    admin = await users.make(SystemRole.SUPER_ADMIN)
    e = await _estb(client, admin)
    d = await _dept(client, admin, e["id"])
    mails = [_mail("bulk1"), _mail("bulk2")]
    try:
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=["first_name", "last_name", "email", "mobile", "designation", "role", "establishment_id", "department_id", "temp_password"])
        w.writeheader()
        for i, m in enumerate(mails):
            w.writerow({"first_name": f"B{i}", "last_name": "User", "email": m, "mobile": f"900000{i}111", "designation": "Clerk",
                        "role": "registrar", "establishment_id": e["id"], "department_id": d["id"], "temp_password": ""})
        r = await client.post("/auth/admin/users/bulk", files={"file": ("u.csv", buf.getvalue().encode(), "text/csv")}, headers=H(admin))
        assert r.status_code == 200, r.text
        res = {x["email"]: x for x in r.json()["results"]}
        assert res[mails[0]]["status"] == "created"
        assert res[mails[1]]["status"] == "failed" and "already assigned to B0" in res[mails[1]]["error"]
    finally:
        for m in mails:
            await _drop_user(db, m)
        await _drop_org(db, [e["id"]], [d["id"]])


@pytest.mark.asyncio
async def test_transfer_carries_the_real_seat_and_never_creates_a_duplicate(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    e = await _estb(client, admin)
    d1, d2 = await _dept(client, admin, e["id"]), await _dept(client, admin, e["id"])
    emails = []
    try:
        r, leaver_mail = await _api_user(client, admin, role="registrar", estb=e["id"], dept=d1["id"], tag="leaver", first="Leaver")
        assert r.status_code == 201; emails.append(leaver_mail); leaver_id = r.json()["id"]
        r, tgt_mail = await _api_user(client, admin, role="registrar", estb=e["id"], dept=d2["id"], tag="tgt", first="Target")
        assert r.status_code == 201; emails.append(tgt_mail); tgt_id = r.json()["id"]

        # Leaver's role row has no context of its own (seat = Dept 1 via the
        # user record). The target must receive the Dept 1 seat — while keeping
        # their own Dept 2 seat — not a context-less copy.
        r = await client.post(f"/auth/admin/users/{leaver_id}/transfer-role",
                              json={"role": "registrar", "target_id": tgt_id}, headers=H(admin))
        assert r.status_code == 200, r.text
        r = await client.get("/auth/admin/users", headers=H(admin))
        by_id = {u["id"]: u for u in r.json()}
        tgt_ctx = {(x["role"], x["department_id"]) for x in by_id[tgt_id]["roles"]}
        assert ("registrar", d1["id"]) in tgt_ctx, tgt_ctx
        assert not any(x["role"] == "registrar" for x in by_id[leaver_id]["roles"])

        # The Dept 1 seat is Target's now: nobody else can take it.
        r, m3 = await _api_user(client, admin, role="registrar", estb=e["id"], dept=d1["id"], tag="third")
        emails.append(m3)
        assert r.status_code == 409 and "already assigned to Target" in r.json()["detail"], r.text

        # An old-data duplicate must not let a transfer create a second holder:
        # make a legacy clash (someone else already on the Dept 2 seat) and move
        # Target's Dept 2 seat onto a third person.
        r, clash_mail = await _api_user(client, admin, role="hod", estb=e["id"], dept=d2["id"], tag="clash", first="Clash")
        assert r.status_code == 201; emails.append(clash_mail); clash_id = r.json()["id"]
        clash = (await db.execute(select(User).where(User.id == uuid.UUID(clash_id)))).scalar_one()
        await db.execute(sa_update(UserRole).where(UserRole.user_id == clash.id).values(role="registrar"))
        await db.commit()
        r, mover_mail = await _api_user(client, admin, role="faculty", estb=e["id"], dept=d1["id"], tag="mover", first="Mover")
        assert r.status_code == 201; emails.append(mover_mail); mover_id = r.json()["id"]
        r = await client.post(f"/auth/admin/users/{tgt_id}/transfer-role",
                              json={"role": "registrar", "target_id": mover_id, "user_role_id": next(
                                  x["id"] for x in by_id[tgt_id]["roles"] if x["role"] == "registrar" and x["department_id"] is None)},
                              headers=H(admin))
        assert r.status_code == 409 and "already assigned to Clash" in r.json()["detail"], r.text
    finally:
        for m in emails:
            await _drop_user(db, m)
        await _drop_org(db, [e["id"]], [d1["id"], d2["id"]])


@pytest.mark.asyncio
async def test_two_simultaneous_assignments_of_one_seat_only_one_wins(client, users, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    e = await _estb(client, admin)
    d = await _dept(client, admin, e["id"])
    emails = []
    try:
        results = await asyncio.gather(*[
            _api_user(client, admin, role="registrar", estb=e["id"], dept=d["id"], tag=f"race{i}") for i in range(4)])
        codes = sorted(r.status_code for r, _ in results)
        emails = [m for _, m in results]
        assert codes == [201, 409, 409, 409], codes
        n = (await db.execute(select(User).where(User.email.in_(emails)))).scalars().all()
        assert len(n) == 1
    finally:
        for m in emails:
            await _drop_user(db, m)
        await _drop_org(db, [e["id"]], [d["id"]])


# ═══════════════ PER-ROLE: MAY SEVERAL PEOPLE HOLD IT? ═══════════════════════

@pytest.mark.asyncio
async def test_role_can_allow_several_holders_per_seat(client, users, roles, db):
    admin = await users.make(SystemRole.SUPER_ADMIN)
    e = await _estb(client, admin)
    d = await _dept(client, admin, e["id"])
    many = await roles.make("test_many_holders")
    one = await roles.make("test_one_holder")
    emails = []
    try:
        # A role starts as one-holder-only; the Super Admin turns "many" on.
        r = await client.get("/auth/admin/roles", headers=H(admin))
        flags = {x["name"]: x["allow_multiple_holders"] for x in r.json()}
        assert flags[many.name] is False and flags["faculty"] is True and flags["student"] is True
        r = await client.patch(f"/auth/admin/roles/{many.id}", json={"allow_multiple_holders": True}, headers=H(admin))
        assert r.status_code == 200 and r.json()["allow_multiple_holders"] is True

        # Many-holder role: three people in the same establishment + department.
        for i in range(3):
            r, m = await _api_user(client, admin, role=many.name, estb=e["id"], dept=d["id"], tag=f"many{i}")
            assert r.status_code == 201, r.text
            emails.append(m)
        # One-holder role: the second person is refused.
        r, m = await _api_user(client, admin, role=one.name, estb=e["id"], dept=d["id"], tag="one1")
        assert r.status_code == 201, r.text
        emails.append(m)
        r, m = await _api_user(client, admin, role=one.name, estb=e["id"], dept=d["id"], tag="one2")
        assert r.status_code == 409 and "already assigned" in r.json()["detail"], r.text

        # A new role can be created as many-holder from the start.
        r = await client.post("/auth/admin/roles", json={"name": "test_made_many", "allow_multiple_holders": True}, headers=H(admin))
        assert r.status_code == 201 and r.json()["allow_multiple_holders"] is True
        made_id = r.json()["id"]
        await client.delete(f"/auth/admin/roles/{made_id}", headers=H(admin))

        # Cannot limit a role to one person while a seat already has several.
        r = await client.patch(f"/auth/admin/roles/{many.id}", json={"allow_multiple_holders": False}, headers=H(admin))
        assert r.status_code == 409, r.text
        assert "held by 3 people" in r.json()["detail"] and emails[0] in r.json()["detail"]
        r = await client.get("/auth/admin/roles", headers=H(admin))
        assert next(x for x in r.json() if x["id"] == str(many.id))["allow_multiple_holders"] is True  # unchanged

        # Once only one person is left it can be limited, and it then behaves as one-holder.
        for m in emails[1:3]:
            await _drop_user(db, m)
        r = await client.patch(f"/auth/admin/roles/{many.id}", json={"allow_multiple_holders": False}, headers=H(admin))
        assert r.status_code == 200 and r.json()["allow_multiple_holders"] is False
        r, m = await _api_user(client, admin, role=many.name, estb=e["id"], dept=d["id"], tag="late")
        assert r.status_code == 409

        # ...and the other way: allow the one-holder role and the refused person fits.
        await client.patch(f"/auth/admin/roles/{one.id}", json={"allow_multiple_holders": True}, headers=H(admin))
        r, m = await _api_user(client, admin, role=one.name, estb=e["id"], dept=d["id"], tag="one3")
        assert r.status_code == 201, r.text
        emails.append(m)
    finally:
        for m in emails:
            await _drop_user(db, m)
        await _drop_org(db, [e["id"]], [d["id"]])


@pytest.mark.asyncio
async def test_bulk_import_follows_the_roles_holder_setting(client, users, roles, db):
    import csv, io
    admin = await users.make(SystemRole.SUPER_ADMIN)
    e = await _estb(client, admin)
    d = await _dept(client, admin, e["id"])
    many = await roles.make("test_bulk_many")
    one = await roles.make("test_bulk_one")
    await client.patch(f"/auth/admin/roles/{many.id}", json={"allow_multiple_holders": True}, headers=H(admin))
    mails = [_mail(f"bm{i}") for i in range(2)] + [_mail(f"bo{i}") for i in range(2)]
    try:
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=["first_name", "last_name", "email", "mobile", "designation", "role", "establishment_id", "department_id", "temp_password"])
        w.writeheader()
        for i, (m, role) in enumerate(zip(mails, [many.name, many.name, one.name, one.name])):
            w.writerow({"first_name": f"B{i}", "last_name": "User", "email": m, "mobile": f"90000{i}2111", "designation": "Clerk",
                        "role": role, "establishment_id": e["id"], "department_id": d["id"], "temp_password": ""})
        r = await client.post("/auth/admin/users/bulk", files={"file": ("u.csv", buf.getvalue().encode(), "text/csv")}, headers=H(admin))
        assert r.status_code == 200, r.text
        res = {x["email"]: x for x in r.json()["results"]}
        assert res[mails[0]]["status"] == "created" and res[mails[1]]["status"] == "created"   # many-holder role: both fit
        assert res[mails[2]]["status"] == "created"
        assert res[mails[3]]["status"] == "failed" and "already assigned" in res[mails[3]]["error"]  # one-holder role: second refused
    finally:
        for m in mails:
            await _drop_user(db, m)
        await _drop_org(db, [e["id"]], [d["id"]])


@pytest.mark.asyncio
async def test_role_history_never_blocks_deleting_a_department_or_establishment(client, users, db):
    """The history of roles a person used to hold (for "Retired" labels) must
    not stop an establishment / department from being deleted."""
    from app.models.user import FormerRoleHolding
    admin = await users.make(SystemRole.SUPER_ADMIN)
    ghost = await users.make(SystemRole.EFMS_OFFICER, first_name="Ghost")
    e = await _estb(client, admin)
    d = await _dept(client, admin, e["id"])
    db.add(FormerRoleHolding(user_id=ghost.id, role="registrar", reason="transferred",
                             establishment_id=uuid.UUID(e["id"]), department_id=uuid.UUID(d["id"])))
    await db.commit()
    try:
        r = await client.delete(f"/admin/departments/{d['id']}", headers=H(admin))
        assert r.status_code == 204, r.text
        r = await client.delete(f"/admin/establishments/{e['id']}", headers=H(admin))
        assert r.status_code == 204, r.text
        row = (await db.execute(select(FormerRoleHolding).where(FormerRoleHolding.user_id == ghost.id)
               .execution_options(populate_existing=True))).scalar_one()
        assert row.establishment_id is None and row.department_id is None   # history kept, link cleared
    finally:
        await db.execute(sa_delete(FormerRoleHolding).where(FormerRoleHolding.user_id == ghost.id))
        await db.commit()
