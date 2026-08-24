"""Unit tests for app.utils.doc_convert._find_soffice()'s PATH + fallback
discovery logic. Nothing here invokes a real LibreOffice/soffice process —
shutil.which() and the filesystem/executable checks are monkeypatched, so
this suite passes on a machine where LibreOffice is not installed (as is the
case in this dev environment) while still exercising the exact code path
that produced a live-server 503 (shutil.which() finding nothing for either
binary name, even though LibreOffice was actually installed at a standard
path the process's PATH didn't include).
"""
import shutil

import pytest

from app.utils import doc_convert
from app.utils.doc_convert import _find_soffice, DocConversionUnavailable


def _which_none(name: str) -> str | None:
    return None


def _isfile_none(path: str) -> bool:
    return False


def _access_none(path: str, mode: int) -> bool:
    return False


def test_path_discovery_finds_soffice(monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda name: "/opt/libreoffice/soffice" if name == "soffice" else None)
    assert _find_soffice() == "/opt/libreoffice/soffice"


def test_path_discovery_falls_back_to_libreoffice(monkeypatch):
    monkeypatch.setattr(shutil, "which", lambda name: "/opt/libreoffice/libreoffice" if name == "libreoffice" else None)
    assert _find_soffice() == "/opt/libreoffice/libreoffice"


def test_no_path_binary_and_no_fallback_raises_unavailable(monkeypatch):
    monkeypatch.setattr(shutil, "which", _which_none)
    monkeypatch.setattr(doc_convert.os.path, "isfile", _isfile_none)
    monkeypatch.setattr(doc_convert.os, "access", _access_none)
    with pytest.raises(DocConversionUnavailable):
        _find_soffice()


def test_fallback_succeeds_when_usr_bin_soffice_exists_and_executable(monkeypatch):
    monkeypatch.setattr(shutil, "which", _which_none)
    monkeypatch.setattr(doc_convert.os.path, "isfile", lambda path: path == "/usr/bin/soffice")
    monkeypatch.setattr(doc_convert.os, "access", lambda path, mode: path == "/usr/bin/soffice")
    assert _find_soffice() == "/usr/bin/soffice"


def test_fallback_skips_nonexecutable_soffice_and_uses_libreoffice(monkeypatch):
    """/usr/bin/soffice exists but isn't executable (e.g. bad permissions) —
    the fallback must not return a path it can't actually run, and must keep
    checking /usr/bin/libreoffice rather than stopping at the first isfile() hit."""
    monkeypatch.setattr(shutil, "which", _which_none)
    monkeypatch.setattr(doc_convert.os.path, "isfile", lambda path: path in ("/usr/bin/soffice", "/usr/bin/libreoffice"))
    monkeypatch.setattr(doc_convert.os, "access", lambda path, mode: path == "/usr/bin/libreoffice")
    assert _find_soffice() == "/usr/bin/libreoffice"


def test_fallback_succeeds_when_only_usr_bin_libreoffice_exists(monkeypatch):
    monkeypatch.setattr(shutil, "which", _which_none)
    monkeypatch.setattr(doc_convert.os.path, "isfile", lambda path: path == "/usr/bin/libreoffice")
    monkeypatch.setattr(doc_convert.os, "access", lambda path, mode: path == "/usr/bin/libreoffice")
    assert _find_soffice() == "/usr/bin/libreoffice"


def test_no_path_binary_and_fallback_paths_missing_raises_unavailable(monkeypatch):
    monkeypatch.setattr(shutil, "which", _which_none)
    monkeypatch.setattr(doc_convert.os.path, "isfile", _isfile_none)
    monkeypatch.setattr(doc_convert.os, "access", _access_none)
    with pytest.raises(DocConversionUnavailable):
        _find_soffice()
