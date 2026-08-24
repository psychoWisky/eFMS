"""Unit tests for app.utils.doc_convert.

- _find_soffice()'s PATH + fallback discovery logic. Nothing here invokes a
  real LibreOffice/soffice process — shutil.which() and the filesystem/
  executable checks are monkeypatched, so this suite passes on a machine
  where LibreOffice is not installed (as is the case in this dev
  environment) while still exercising the exact code path that produced a
  live-server 503 (shutil.which() finding nothing for either binary name,
  even though LibreOffice was actually installed at a standard path the
  process's PATH didn't include).

- _run_soffice_convert()'s per-call isolated LibreOffice profile
  (-env:UserInstallation=...), which fixes a second live-server bug: under
  concurrent Gunicorn workers, every soffice invocation previously shared
  the same default profile directory, causing profile-lock contention where
  some concurrent conversions failed with "Conversion produced no output."
  even though each succeeded fine in isolation. subprocess.run is
  monkeypatched to a fake that records the command it was given and writes
  a fake output file, so this is verified without a real soffice binary.
"""
import os
import shutil
import subprocess

import pytest

from app.utils import doc_convert
from app.utils.doc_convert import _find_soffice, DocConversionUnavailable, convert_html_to_pdf


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


# ── Per-call isolated LibreOffice profile (-env:UserInstallation=...) ───────

class _FakeCompletedProcess:
    def __init__(self, returncode=0, stderr=b""):
        self.returncode = returncode
        self.stderr = stderr


def _make_fake_run(out_ext: str, out_bytes: bytes = b"%PDF-fake-output%"):
    """A stand-in for subprocess.run that never touches LibreOffice: it
    records the exact command it was called with, then simulates a
    successful conversion by writing `out_bytes` to the output path the real
    soffice invocation would have produced (derived from --outdir and the
    source filename), so _run_soffice_convert's post-call existence check
    passes without a real binary."""
    calls: list[list[str]] = []

    def _fake_run(cmd, capture_output=True, timeout=60):
        calls.append(cmd)
        outdir = cmd[cmd.index("--outdir") + 1]
        src_path = cmd[-1]
        base_name = os.path.splitext(os.path.basename(src_path))[0]
        out_path = os.path.join(outdir, f"{base_name}.{out_ext}")
        with open(out_path, "wb") as f:
            f.write(out_bytes)
        return _FakeCompletedProcess(returncode=0)

    return _fake_run, calls


def _profile_arg(cmd: list[str]) -> str:
    matches = [arg for arg in cmd if arg.startswith("-env:UserInstallation=")]
    assert len(matches) == 1, f"expected exactly one -env:UserInstallation= argument, got {matches}"
    return matches[0]


def test_conversion_passes_env_user_installation_argument(monkeypatch):
    monkeypatch.setattr(doc_convert, "_find_soffice", lambda: "/usr/bin/soffice")
    fake_run, calls = _make_fake_run("pdf")
    monkeypatch.setattr(subprocess, "run", fake_run)

    result = convert_html_to_pdf(b"<html><body>hi</body></html>")

    assert result == b"%PDF-fake-output%"
    assert len(calls) == 1
    profile_arg = _profile_arg(calls[0])
    assert profile_arg.startswith("-env:UserInstallation=file://")
    assert profile_arg.endswith("lo-profile") or "/lo-profile" in profile_arg or "\\lo-profile" in profile_arg


def test_each_conversion_gets_a_unique_profile(monkeypatch):
    """Two conversions (simulating two concurrent/sequential Gunicorn-worker
    requests) must never be pointed at the same LibreOffice profile — that
    shared-profile contention is exactly what caused the live-server
    "Conversion produced no output." failures under concurrency."""
    monkeypatch.setattr(doc_convert, "_find_soffice", lambda: "/usr/bin/soffice")
    fake_run, calls = _make_fake_run("pdf")
    monkeypatch.setattr(subprocess, "run", fake_run)

    convert_html_to_pdf(b"<html>one</html>")
    convert_html_to_pdf(b"<html>two</html>")

    assert len(calls) == 2
    profile_1 = _profile_arg(calls[0])
    profile_2 = _profile_arg(calls[1])
    assert profile_1 != profile_2


def test_profile_argument_immediately_follows_norestore(monkeypatch):
    """Confirms the other flags (--headless, --norestore, --convert-to,
    --outdir, 60s timeout) are unchanged in shape/order around the new arg."""
    monkeypatch.setattr(doc_convert, "_find_soffice", lambda: "/usr/bin/soffice")
    fake_run, calls = _make_fake_run("pdf")
    monkeypatch.setattr(subprocess, "run", fake_run)

    convert_html_to_pdf(b"<html></html>")

    cmd = calls[0]
    assert cmd[0] == "/usr/bin/soffice"
    assert "--headless" in cmd
    assert "--norestore" in cmd
    assert cmd[cmd.index("--norestore") + 1].startswith("-env:UserInstallation=")
    assert "--convert-to" in cmd and cmd[cmd.index("--convert-to") + 1] == "pdf"
    assert "--outdir" in cmd
