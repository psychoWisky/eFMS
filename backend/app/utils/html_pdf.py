"""Headless-Chromium HTML -> PDF, used ONLY by the notesheet download.

Every other document conversion in this codebase still goes through
LibreOffice (app/utils/doc_convert.py) and is unaffected by this module.
The notesheet download is the one place that needs a modern CSS engine
(flexbox, letter-spacing, justified text, @page margins, web fonts), which
LibreOffice's ~2000-era HTML importer does not support, so it renders the
notesheet HTML in real Chromium via Playwright instead.

Requires, on the server:
    pip install playwright
    python -m playwright install --with-deps chromium

If Playwright or the browser binary is missing, render_html_to_pdf raises
ChromiumUnavailable and the caller falls back to LibreOffice.
"""
from __future__ import annotations


class ChromiumUnavailable(Exception):
    """Playwright and/or its bundled Chromium is not installed on this server."""


class ChromiumRenderFailed(Exception):
    """Chromium launched but did not produce a usable PDF."""


def render_html_to_pdf(html: str) -> bytes:
    """Render a full HTML document string to PDF bytes using headless
    Chromium. Page size / margins come from the document's own @page CSS
    (prefer_css_page_size=True); print_background=True so borders, rules
    and shaded cells show up.

    Synchronous on purpose: it uses Playwright's sync API in its own
    thread-safe subprocess-backed driver, so it can be called from a
    threadpool via fastapi.concurrency.run_in_threadpool without touching
    the running event loop.
    """
    try:
        from playwright.sync_api import sync_playwright
        from playwright._impl._errors import Error as PlaywrightError
    except ImportError as exc:  # Playwright not installed at all.
        raise ChromiumUnavailable(str(exc)) from exc

    try:
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(
                    args=["--no-sandbox", "--disable-dev-shm-usage"],
                )
            except PlaywrightError as exc:
                # Almost always: browser binary not downloaded yet
                # ("Executable doesn't exist ... playwright install").
                raise ChromiumUnavailable(str(exc)) from exc

            try:
                page = browser.new_page()
                page.set_content(html, wait_until="networkidle")
                pdf_bytes = page.pdf(
                    print_background=True,
                    prefer_css_page_size=True,
                    margin={"top": "0", "right": "0", "bottom": "0", "left": "0"},
                )
            finally:
                browser.close()
    except ChromiumUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 - any launch/render failure
        raise ChromiumRenderFailed(str(exc)) from exc

    if not pdf_bytes:
        raise ChromiumRenderFailed("Chromium produced an empty PDF.")

    return pdf_bytes
