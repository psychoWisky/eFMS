"""Signing with the officer's DSC (USB token). Authority is as before — only
people with sign permission, only on a file forwarded to them — and every
signature is made on the token (here: a simulated Capricorn signing
application). OTP signing is gone."""
import io
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, update as sa_update, delete as sa_delete

from app.core.config import settings
from app.models.efms import EfmsFile, FileAttachment
from app.models.efms_extra import FileSignature
from app.models.user import SystemRole, User
from tests.conftest import auth_headers as H
from tests.dsc_sim import make_identity, sample_pdf, sign_hash


from app.models.user import UserRole


async def _grant(db, *people):
    for p in people:
        await db.execute(sa_update(User).where(User.id == p.id).values(can_sign=True))
        # the permission belongs to the post (role) — give it for all of this person's posts
        await db.execute(sa_update(UserRole).where(UserRole.user_id == p.id).values(can_sign=True))
    await db.commit()


async def _file_with_pdf(client, creator):
    r = await client.post("/efms/files", json={"subject": f"DSC test {uuid.uuid4().hex[:6]}", "category": "general", "initial_content": "x"}, headers=H(creator))
    assert r.status_code == 201, r.text
    fid = r.json()["id"]
    r = await client.post(f"/efms/files/{fid}/attachments", files={"upload": ("order.pdf", sample_pdf(2), "application/pdf")}, headers=H(creator))
    assert r.status_code == 201, r.text
    return fid


async def _forward(client, fid, frm, to):
    r = await client.post(f"/efms/files/{fid}/route", json={"action": "forward", "to_user_id": str(to.id)}, headers=H(frm))
    assert r.status_code == 200, r.text


async def _cleanup(db, fid):
    f = await db.get(EfmsFile, uuid.UUID(fid))
    if f:
        for a in (await db.execute(select(FileAttachment).where(FileAttachment.file_id == f.id))).scalars().all():
            try:
                os.remove(os.path.join(os.path.abspath(settings.UPLOAD_DIR), a.stored_name))
            except OSError:
                pass
        for s in (await db.execute(select(FileSignature).where(FileSignature.file_id == f.id))).scalars().all():
            if s.prepared_name:
                try:
                    os.remove(os.path.join(os.path.dirname(os.path.abspath(settings.UPLOAD_DIR)), "dsc_pending", s.prepared_name))
                except OSError:
                    pass
        from app.models.efms_extra import Docket
        await db.execute(sa_delete(Docket).where(Docket.file_id == f.id))
        await db.delete(f)
        await db.commit()


async def _sign(client, fid, who, key, cert, pos=(50, 80), page="first"):
    r = await client.post(f"/efms/files/{fid}/sign/prepare", json={"pos_x": pos[0], "pos_y": pos[1], "page": page}, headers=H(who))
    assert r.status_code == 201, r.text
    prep = r.json()
    assert len(prep["hash"]) == 64
    return prep, await client.post(f"/efms/files/{fid}/sign/{prep['signature_id']}/complete",
                                   json={"cms_b64": sign_hash(prep["hash"], key, cert)}, headers=H(who))


@pytest.mark.asyncio
async def test_authority_and_two_officers_signing_in_turn(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    o1 = await users.make(SystemRole.EFMS_OFFICER, first_name="First")
    o2 = await users.make(SystemRole.EFMS_OFFICER, first_name="Second")
    plain = await users.make(SystemRole.EFMS_OFFICER, first_name="Plain")
    await _grant(db, creator, o1, o2)                      # `plain` has no sign permission
    k1, c1 = make_identity("Dr. First Officer"); k2, c2 = make_identity("Dr. Second Officer")
    fid = await _file_with_pdf(client, creator)
    try:
        # Still drafting: even someone with sign permission cannot sign their own file.
        r = await client.post(f"/efms/files/{fid}/sign/prepare", json={"pos_x": 50, "pos_y": 50}, headers=H(creator))
        assert r.status_code == 403 and "drafting" in r.json()["detail"]
        # The old OTP endpoints are gone.
        assert (await client.post(f"/efms/files/{fid}/sign", json={"pos_x": 1, "pos_y": 1}, headers=H(creator))).status_code in (404, 405)

        await _forward(client, fid, creator, plain)
        r = await client.post(f"/efms/files/{fid}/sign/prepare", json={"pos_x": 50, "pos_y": 50}, headers=H(plain))
        assert r.status_code == 403 and "permission" in r.json()["detail"]

        await _forward(client, fid, plain, o1)
        # Not the holder → no.
        assert (await client.post(f"/efms/files/{fid}/sign/prepare", json={"pos_x": 50, "pos_y": 50}, headers=H(o2))).status_code == 403

        prep, r = await _sign(client, fid, o1, k1, c1)
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["status"] == "verified" and out["method"] == "dsc" and out["cert_cn"] == "Dr. First Officer" and out["cert_serial"]
        atts = {a.original_name: a for a in (await db.execute(select(FileAttachment).where(FileAttachment.file_id == uuid.UUID(fid)))).scalars().all()}
        assert set(atts) == {"order.pdf", "order_signed.pdf"}
        # the prepared copy is gone from the private folder
        assert not os.path.exists(os.path.join(os.path.dirname(os.path.abspath(settings.UPLOAD_DIR)), "dsc_pending", prep["signature_id"] + ".pdf"))
        # the same person cannot sign twice on the same prepared request
        r = await client.post(f"/efms/files/{fid}/sign/{prep['signature_id']}/complete", json={"cms_b64": sign_hash(prep["hash"], k1, c1)}, headers=H(o1))
        assert r.status_code == 400

        # Forward upward; the next officer signs the SIGNED copy, so both signatures stay.
        await _forward(client, fid, o1, o2)
        assert (await client.post(f"/efms/files/{fid}/sign/prepare", json={"pos_x": 50, "pos_y": 50}, headers=H(o1))).status_code == 403
        prep2, r = await _sign(client, fid, o2, k2, c2, pos=(30, 40), page="last")
        assert r.status_code == 200, r.text
        assert r.json()["cert_cn"] == "Dr. Second Officer"
        atts = {a.original_name: a for a in (await db.execute(select(FileAttachment).where(FileAttachment.file_id == uuid.UUID(fid)).execution_options(populate_existing=True))).scalars().all()}
        assert set(atts) == {"order.pdf", "order_signed.pdf"}                       # still one signed copy
        signed = open(os.path.join(os.path.abspath(settings.UPLOAD_DIR), atts["order_signed.pdf"].stored_name), "rb").read()
        from pyhanko.pdf_utils.reader import PdfFileReader
        from pyhanko.sign.validation import async_validate_pdf_signature
        reader = PdfFileReader(io.BytesIO(signed))
        embedded = list(reader.embedded_signatures)
        assert [e.field_name for e in embedded] == ["Signature1", "Signature2"]
        for e in embedded:
            st = await async_validate_pdf_signature(e)
            assert st.intact and st.valid
        # the file shows both signatures with their certificates
        f = (await client.get(f"/efms/files/{fid}", headers=H(o2))).json()
        assert [s["cert_cn"] for s in f["signatures"]] == ["Dr. First Officer", "Dr. Second Officer"]
    finally:
        await _cleanup(db, fid)


@pytest.mark.asyncio
async def test_bad_signature_expired_certificate_and_cancel(client, users, db):
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    o1 = await users.make(SystemRole.EFMS_OFFICER, first_name="First")
    other = await users.make(SystemRole.EFMS_OFFICER, first_name="Other")
    await _grant(db, o1, other)
    k, c = make_identity("Dr. First Officer"); k_old, c_old = make_identity("Dr. Expired", valid_days=-1, start_days_ago=400)
    fid = await _file_with_pdf(client, creator)
    try:
        await _forward(client, fid, creator, o1)
        # A signature for some other digest is refused and nothing is signed.
        r = await client.post(f"/efms/files/{fid}/sign/prepare", json={"pos_x": 50, "pos_y": 50}, headers=H(o1))
        prep = r.json()
        r = await client.post(f"/efms/files/{fid}/sign/{prep['signature_id']}/complete", json={"cms_b64": sign_hash("AB" * 32, k, c)}, headers=H(o1))
        assert r.status_code == 400 and "different document digest" in r.json()["detail"]
        # garbage is refused
        r = await client.post(f"/efms/files/{fid}/sign/{prep['signature_id']}/complete", json={"cms_b64": "A" * 200}, headers=H(o1))
        assert r.status_code == 400
        # somebody else cannot finish it
        r = await client.post(f"/efms/files/{fid}/sign/{prep['signature_id']}/complete", json={"cms_b64": sign_hash(prep["hash"], k, c)}, headers=H(other))
        assert r.status_code == 403

        # An expired certificate is refused (unless explicitly allowed for testing).
        prep, r = await _sign(client, fid, o1, k_old, c_old)
        assert r.status_code == 400 and "expired" in r.json()["detail"]
        assert (await db.execute(select(FileAttachment).where(FileAttachment.file_id == uuid.UUID(fid), FileAttachment.original_name == "order_signed.pdf"))).first() is None
        settings.DSC_ALLOW_EXPIRED_CERT = True
        try:
            prep, r = await _sign(client, fid, o1, k_old, c_old)
            assert r.status_code == 200, r.text
        finally:
            settings.DSC_ALLOW_EXPIRED_CERT = False

        # Cancel drops the prepared copy; a request that waited too long expires.
        r = await client.post(f"/efms/files/{fid}/sign/prepare", json={"pos_x": 50, "pos_y": 50}, headers=H(o1))
        sid = r.json()["signature_id"]
        row = await db.get(FileSignature, uuid.UUID(sid)); name = row.prepared_name
        assert (await client.post(f"/efms/files/{fid}/sign/{sid}/cancel", headers=H(o1))).status_code == 204
        assert not os.path.exists(os.path.join(os.path.dirname(os.path.abspath(settings.UPLOAD_DIR)), "dsc_pending", name))
        r = await client.post(f"/efms/files/{fid}/sign/prepare", json={"pos_x": 50, "pos_y": 50}, headers=H(o1))
        prep = r.json()
        await db.execute(sa_update(FileSignature).where(FileSignature.id == uuid.UUID(prep["signature_id"])).values(created_at=datetime.now(timezone.utc) - timedelta(minutes=30)))
        await db.commit()
        r = await client.post(f"/efms/files/{fid}/sign/{prep['signature_id']}/complete", json={"cms_b64": sign_hash(prep["hash"], k, c)}, headers=H(o1))
        assert r.status_code == 400 and "expired" in r.json()["detail"]
    finally:
        await _cleanup(db, fid)


@pytest.mark.asyncio
async def test_permission_is_per_role(client, users, db):
    """A person with two roles can sign only in the role that was granted."""
    from sqlalchemy import select
    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="PRCreator")
    two = await users.make(SystemRole.EFMS_OFFICER, first_name="TwoRoles")
    admin = await users.make(SystemRole.SUPER_ADMIN, first_name="PRAdmin")
    db.add(UserRole(user_id=two.id, role=SystemRole.REGISTRAR.value))
    await db.commit()
    rows = (await db.execute(select(UserRole).where(UserRole.user_id == two.id))).scalars().all()
    officer_ur = next(r for r in rows if r.role == SystemRole.EFMS_OFFICER.value)
    # grant ONLY the officer post
    r = await client.patch(f"/admin/user-roles/{officer_ur.id}/sign-permission", json={"can_sign": True}, headers=H(admin))
    assert r.status_code == 200, r.text
    cands = (await client.get("/admin/sign-permissions/candidates", headers=H(admin))).json()
    assert any(c["user_id"] == str(two.id) and c["role"] == SystemRole.REGISTRAR.value for c in cands)
    granted = (await client.get("/admin/sign-permissions", headers=H(admin))).json()
    assert any(g["id"] == str(officer_ur.id) and g["role_label"] for g in granted)
    assert not any(g["user_id"] == str(two.id) and g["role"] == SystemRole.REGISTRAR.value for g in granted)
    from app.utils.signing import user_can_sign_now
    await db.refresh(two)
    assert await user_can_sign_now(db, two) is True          # working as officer
    two.active_role = SystemRole.REGISTRAR.value
    await db.commit()
    assert await user_can_sign_now(db, two) is False         # working as registrar
