"""LibreOffice-based document conversions, for preview/download purposes only.

Two conversions live here, both purely temporary/in-memory artifacts that
never touch the original stored file:

- convert_doc_to_docx: legacy .doc -> .docx, so the existing docx-preview-
  based renderer (already used for native .docx attachments, and by the
  eSign feature) can display a .doc without a second .doc-specific viewer.
- convert_html_to_pdf: the standalone HTML document download_notesheet()
  already builds from notesheet.content -> a downloadable PDF, so
  "Download Notesheet" produces a real PDF instead of an .html file.

Both share the same tempfile + headless LibreOffice subprocess pattern
(_run_soffice_convert) so there is exactly one conversion mechanism, not one
per feature. Requires LibreOffice's headless CLI ("soffice") on the server.
If it isn't present, callers should catch DocConversionUnavailable and
return a clean "conversion not available" response rather than fail hard.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path


class DocConversionUnavailable(Exception):
    """No LibreOffice ("soffice") conversion tool is installed on this server."""


class DocConversionFailed(Exception):
    """The conversion tool ran but did not produce usable output."""


_FALLBACK_SOFFICE_PATHS = ("/usr/bin/soffice", "/usr/bin/libreoffice")


def _find_soffice() -> str:
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if soffice:
        return soffice
    # shutil.which() only searches this process's PATH, which can differ
    # from an interactive login shell's (e.g. a service manager launching
    # this process with a minimal PATH) even when LibreOffice is genuinely
    # installed at its standard location. Fall back to checking the usual
    # Debian/Ubuntu install paths directly before giving up.
    for path in _FALLBACK_SOFFICE_PATHS:
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    raise DocConversionUnavailable("LibreOffice (soffice) is not installed on this server.")


def _run_soffice_convert(content: bytes, src_filename: str, target_format: str, out_ext: str) -> bytes:
    """Write `content` to a temp file named `src_filename`, convert it via
    headless LibreOffice to `target_format` (e.g. "docx", "pdf"), and return
    the resulting bytes. Each call gets its own tempfile.TemporaryDirectory,
    so concurrent requests never collide on filenames, and the directory
    (and everything in it) is removed automatically once this returns or
    raises — nothing here ever touches a caller-supplied path."""
    soffice = _find_soffice()

    with tempfile.TemporaryDirectory() as tmp_dir:
        src_path = os.path.join(tmp_dir, src_filename)
        with open(src_path, "wb") as f:
            f.write(content)

        # Concurrent requests share the same server, so without an isolated
        # profile every simultaneous soffice invocation fights over the same
        # default LibreOffice user profile (~/.config/libreoffice/), which
        # can make one of them fail with no output despite running fine in
        # isolation. Each call gets its own scratch profile inside its own
        # tmp_dir — never shared, never reused, cleaned up with everything
        # else when tmp_dir is removed.
        lo_profile = os.path.join(tmp_dir, "lo-profile")
        profile_uri = Path(lo_profile).absolute().as_uri()

        try:
            result = subprocess.run(
                [soffice, "--headless", "--norestore", f"-env:UserInstallation={profile_uri}",
                 "--convert-to", target_format, "--outdir", tmp_dir, src_path],
                capture_output=True, timeout=60,
            )
        except subprocess.TimeoutExpired as exc:
            raise DocConversionFailed("Conversion timed out.") from exc

        base_name = os.path.splitext(src_filename)[0]
        out_path = os.path.join(tmp_dir, f"{base_name}.{out_ext}")
        if result.returncode != 0 or not os.path.exists(out_path):
            detail = result.stderr.decode(errors="ignore").strip() or "Conversion produced no output."
            raise DocConversionFailed(detail)

        with open(out_path, "rb") as f:
            return f.read()


def convert_doc_to_docx(content: bytes) -> bytes:
    return _run_soffice_convert(content, "input.doc", "docx", "docx")


def convert_html_to_pdf(html: bytes) -> bytes:
    return _run_soffice_convert(html, "input.html", "pdf", "pdf")
