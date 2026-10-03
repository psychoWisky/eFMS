"""Notesheet HTML (rich-text editor output): pictures and tables are kept,
anything dangerous is removed — on save, and again when the PDF is built."""
import pytest
from uuid import UUID

from sqlalchemy import select

from app.models.efms import EfmsFile, Notesheet
from app.models.user import SystemRole
from app.utils import html_pdf
from app.utils.html_sanitize import MAX_CONTENT_BYTES, sanitize_notesheet_html as S
from tests.conftest import auth_headers

PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="


# ── the sanitiser itself ─────────────────────────────────────────────────────

@pytest.mark.parametrize("html,gone", [
    ('<p>a</p><script>alert(1)</script>', "script"),
    ('<img src="x" onerror="alert(1)">', "onerror"),
    ('<iframe src="file:///etc/passwd"></iframe>text', "iframe"),
    ('<img src="http://169.254.169.254/latest/meta-data/">', "169.254"),
    ('<img src="data:image/svg+xml;base64,PHN2Zz4=">', "svg"),
    ('<a href="javascript:alert(1)">x</a>', "javascript"),
    ('<p style="background:url(http://evil/x);text-align:center">x</p>', "evil"),
    ('<p style="width: expression(alert(1))">x</p>', "expression"),
    ('<form action="http://evil"><input name=a></form>hi', "form"),
    ('<style>body{display:none}</style>hello', "style"),
])
def test_dangerous_markup_is_removed(html, gone):
    assert gone not in S(html).lower()


def test_editor_output_is_kept():
    kept = [
        f'<p><img src="{PNG}" width="50%" alt="x"></p>',
        '<table style="width: 80%"><colgroup><col style="width: 120px"></colgroup><tbody>'
        '<tr style="height: 40px"><th colspan="2" colwidth="120,80">H</th></tr>'
        '<tr><td style="background-color: #FEF08A">c</td></tr></tbody></table>',
        '<mark data-color="#FEF08A" style="background-color: #FEF08A; color: inherit">hi</mark>',
        '<p style="text-align: center">x</p>',
    ]
    for html in kept:
        assert S(html) == html


def test_legacy_plain_text_and_empty_pass_through():
    assert S("a < b & c") == "a < b & c"
    assert S("") == "" and S(None) == ""


def test_oversized_content_is_refused_only_when_enforced():
    big = "<p>" + "x" * (MAX_CONTENT_BYTES + 10) + "</p>"
    with pytest.raises(ValueError):
        S(big)
    assert S(big, enforce_limit=False)  # the PDF path never fails on an old row


# ── through the API ──────────────────────────────────────────────────────────

async def _create(client, user, content, subject="Notesheet html test file"):
    return await client.post(
        "/efms/files",
        json={"subject": subject, "category": "general", "initial_content": content},
        headers=auth_headers(user),
    )


async def _drop(db, fid):
    f = await db.get(EfmsFile, UUID(fid))
    if f:
        await db.delete(f)
        await db.commit()


@pytest.mark.asyncio
async def test_save_strips_scripts_but_keeps_pictures_and_tables(client, users, db):
    u = await users.make(SystemRole.EFMS_OFFICER, first_name="Writer")
    dirty = (f'<p onclick="x()">Hello</p><script>steal()</script><img src="{PNG}" width="120">'
             '<table><tbody><tr><td style="width: 90px">c</td></tr></tbody></table>')
    r = await _create(client, u, dirty)
    assert r.status_code == 201, r.text
    fid = r.json()["id"]
    try:
        content = r.json()["notesheet"]["content"]
        assert "script" not in content and "onclick" not in content
        assert f'src="{PNG}"' in content and "<table>" in content and "width: 90px" in content

        # saving again (draft edit) is sanitised too
        r = await client.patch(f"/efms/files/{fid}/notesheet",
                               json={"content": '<p>ok</p><iframe src="file:///etc/passwd"></iframe>'},
                               headers=auth_headers(u))
        assert r.status_code == 200, r.text
        stored = (await client.get(f"/efms/files/{fid}", headers=auth_headers(u))).json()["notesheet"]["content"]
        assert "iframe" not in stored and "<p>ok</p>" in stored
    finally:
        await _drop(db, fid)


@pytest.mark.asyncio
async def test_a_picture_only_notesheet_can_be_forwarded(client, users, db):
    sender = await users.make(SystemRole.EFMS_OFFICER, first_name="Sender")
    receiver = await users.make(SystemRole.EFMS_OFFICER, first_name="Receiver")
    r = await _create(client, sender, f'<p><img src="{PNG}"></p>')
    assert r.status_code == 201, r.text
    fid = r.json()["id"]
    try:
        r = await client.post(f"/efms/files/{fid}/route",
                              json={"action": "forward", "to_user_id": str(receiver.id)},
                              headers=auth_headers(sender))
        assert r.status_code == 200, r.text   # not "write the notesheet before forwarding"
    finally:
        await _drop(db, fid)


@pytest.mark.asyncio
async def test_an_oversized_notesheet_gets_a_clear_message(client, users):
    u = await users.make(SystemRole.EFMS_OFFICER, first_name="Big")
    r = await _create(client, u, "<p>" + "x" * (MAX_CONTENT_BYTES + 10) + "</p>")
    assert r.status_code == 413, r.status_code
    assert "too large" in r.json()["detail"]


@pytest.mark.asyncio
async def test_pdf_html_contains_the_picture_and_nothing_dangerous(client, users, db, monkeypatch):
    u = await users.make(SystemRole.EFMS_OFFICER, first_name="Printer")
    r = await _create(client, u, f'<p>Look:</p><p><img src="{PNG}" width="200"></p>')
    assert r.status_code == 201, r.text
    fid = r.json()["id"]
    try:
        # A row saved before sanitising existed: dirty content straight in the DB.
        ns = (await db.execute(select(Notesheet).where(Notesheet.file_id == UUID(fid)))).scalar_one()
        ns.content += '<script>steal()</script><img src="http://169.254.169.254/x">'
        await db.commit()

        seen = {}
        monkeypatch.setattr(html_pdf, "render_html_to_pdf", lambda html: seen.setdefault("html", html) and b"%PDF-1.4")
        r = await client.get(f"/efms/files/{fid}/notesheet/download", headers=auth_headers(u))
        assert r.status_code == 200, r.text
        html = seen["html"]
        assert f'src="{PNG}"' in html
        assert "steal()" not in html and "169.254" not in html
    finally:
        await _drop(db, fid)
