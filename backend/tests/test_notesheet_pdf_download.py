"""GET /efms/files/{file_id}/notesheet/download — exception-to-status-code
mapping only. Does not invoke a real LibreOffice process: _find_soffice is
monkeypatched to raise DocConversionUnavailable directly, reproducing the
live-server 503 deterministically without needing soffice installed."""
import pytest

from app.models.user import SystemRole
from app.models.efms import EfmsFile
from app.utils import doc_convert
from app.utils.doc_convert import DocConversionUnavailable
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
async def test_notesheet_download_returns_503_when_soffice_unavailable(client, users, db, monkeypatch):
    def _raise_unavailable():
        raise DocConversionUnavailable("LibreOffice (soffice) is not installed on this server.")

    monkeypatch.setattr(doc_convert, "_find_soffice", _raise_unavailable)

    creator = await users.make(SystemRole.EFMS_OFFICER, first_name="Creator")
    file_id = await _create_file(client, creator)
    try:
        r = await client.get(f"/efms/files/{file_id}/notesheet/download", headers=auth_headers(creator))
        assert r.status_code == 503
        assert r.json()["detail"] == "PDF generation is not available on this server."
    finally:
        await _delete_file(db, file_id)
