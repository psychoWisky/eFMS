"""GET /efms/files/{file_id}/notesheet/download — exception-to-status-code
mapping only. Does not invoke a real Chromium or LibreOffice process: the
notesheet download tries headless Chromium first and falls back to
LibreOffice, so both are monkeypatched to be "unavailable" here, which is
what reproduces the live-server 503 deterministically without needing
either engine installed."""
import pytest

from app.models.user import SystemRole
from app.models.efms import EfmsFile
from app.utils import doc_convert, html_pdf
from app.utils.doc_convert import DocConversionUnavailable
from app.utils.html_pdf import ChromiumUnavailable
from tests.conftest import auth_headers


async def _create_file(client, creator, subject="Notesheet PDF download test"):
    r = await client.post(
        "/efms/files",
        json={"subject": subject, "category": "general", "initial_content": "initial content"},
        headers=auth_headers(creator),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _delete_file(db, file_id):
    f = await db.get(EfmsFile, file_id)
    if f:
        await db.delete(f)
        await db.commit()


@pytest.mark.asyncio
async def test_notesheet_download_returns_503_when_no_engine_available(client, users, db, monkeypatch):
    def _chromium_unavailable(_html):
        raise ChromiumUnavailable("Playwright/Chromium is not installed on this server.")

    def _soffice_unavailable():
        raise DocConversionUnavailable("LibreOffice (soffice) is not installed on this server.")

    # Chromium is tried first, LibreOffice is the fallback — knock out both.
    monkeypatch.setattr(html_pdf, "render_html_to_pdf", _chromium_unavailable)
    monkeypatch.setattr(doc_convert, "_find_soffice", _soffice_unavailable)

    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    file_id = await _create_file(client, creator)
    try:
        r = await client.get(f"/efms/files/{file_id}/notesheet/download", headers=auth_headers(creator))
        assert r.status_code == 503
        assert r.json()["detail"] == "PDF generation is not available on this server."
    finally:
        await _delete_file(db, file_id)
