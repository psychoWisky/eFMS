"""Sanitising for notesheet / remark HTML (rich-text editor output).

Why this exists: notesheet HTML is written by any signed-in user, shown in
other users' browsers, and injected into a page that headless Chromium
renders on the SERVER to build the PDF. Left raw, a notesheet could carry a
<script>, an event handler, an <iframe src="file:///…"> or an <img> pointing
at an internal address. Everything is therefore reduced to the small set the
editor itself produces: text formatting, lists, tables (with widths /
colours), and images embedded as data: URIs. Remote images are not allowed —
the PDF renderer would fetch them from the server's network.

Applied when content is saved AND again when the PDF is built (which also
covers rows saved before this existed). Legacy plain-text notesheets (no
tags) are returned unchanged.
"""
import re
from typing import Optional

import nh3

# Same test the frontend uses to tell editor HTML from legacy plain text.
_HTML_TAG = re.compile(r"<([a-z][a-z0-9]*)\b[^>]*>", re.I)

# One data: image is capped on its own, and the whole notesheet is capped,
# so a single request cannot store hundreds of megabytes.
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_CONTENT_BYTES = 15 * 1024 * 1024

_ALLOWED_TAGS = {
    "p", "br", "div", "span", "strong", "b", "em", "i", "u", "s", "strike",
    "mark", "sub", "sup", "h1", "h2", "h3", "h4", "ul", "ol", "li",
    "blockquote", "pre", "code", "hr", "a", "img",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "colgroup", "col",
}

_ALLOWED_ATTRIBUTES = {
    "*": {"style"},
    "a": {"href", "title", "target"},
    "img": {"src", "alt", "title", "width", "height"},
    # Tiptap writes column widths as a plain `colwidth` attribute.
    "td": {"colspan", "rowspan", "colwidth", "data-colwidth"},
    "th": {"colspan", "rowspan", "colwidth", "data-colwidth"},
    "col": {"span"},
    "colgroup": {"span"},
    "mark": {"data-color"},
    "ol": {"start", "type"},
}

_DATA_IMAGE = re.compile(r"^data:image/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$", re.I)
_IMG_WITHOUT_SRC = re.compile(r"<img(?![^>]*\ssrc=)[^>]*>", re.I)
_SAFE_HREF = re.compile(r"^(?:https?://|mailto:)", re.I)

# CSS properties the editor needs, and nothing else.
_ALLOWED_CSS = {
    "text-align", "background-color", "color", "width", "min-width",
    "max-width", "height", "min-height", "vertical-align", "font-weight",
    "font-style", "text-decoration", "display", "margin-left", "margin-right",
    "float",
}
_CSS_VALUE = re.compile(r"^[#\w\s.,%()+-]{1,80}$")
_CSS_BAD = re.compile(r"url\s*\(|expression|javascript|@import|\\|/\*", re.I)


def _clean_style(style: str) -> Optional[str]:
    kept = []
    for decl in style.split(";"):
        if ":" not in decl:
            continue
        prop, _, value = decl.partition(":")
        prop, value = prop.strip().lower(), value.strip()
        if prop in _ALLOWED_CSS and _CSS_VALUE.match(value) and not _CSS_BAD.search(value):
            kept.append(f"{prop}: {value}")
    return "; ".join(kept) or None


def _filter_attribute(tag: str, attr: str, value: str) -> Optional[str]:
    if attr == "style":
        return _clean_style(value)
    if tag == "img" and attr == "src":
        return value if (_DATA_IMAGE.match(value) and len(value) <= MAX_IMAGE_BYTES * 4 // 3 + 64) else None
    if tag == "a" and attr == "href":
        return value if _SAFE_HREF.match(value.strip()) else None
    if attr in ("width", "height") and not re.fullmatch(r"\d{1,5}%?", value.strip()):
        return None
    if attr in ("colwidth", "data-colwidth") and not re.fullmatch(r"[\d,]{1,40}", value):
        return None
    if attr in ("colspan", "rowspan", "span", "start") and not re.fullmatch(r"\d{1,3}", value.strip()):
        return None
    return value


class ContentTooLarge(ValueError):
    """The notesheet (usually its images) exceeds the size limit."""


def looks_like_html(text: str) -> bool:
    return bool(_HTML_TAG.search(text))


def sanitize_notesheet_html(html: Optional[str], *, enforce_limit: bool = True) -> str:
    """Clean editor HTML. Plain text and empty values pass through
    unchanged. With enforce_limit (the save paths) an oversized value raises
    ContentTooLarge; the PDF path passes False so an old row never breaks
    a download."""
    if not html:
        return html or ""
    if enforce_limit and len(html.encode("utf-8")) > MAX_CONTENT_BYTES:
        raise ContentTooLarge(
            f"This notesheet is too large (limit {MAX_CONTENT_BYTES // (1024 * 1024)} MB). "
            "Remove an image or paste smaller ones."
        )
    if not looks_like_html(html):
        return html
    cleaned = nh3.clean(
        html,
        tags=_ALLOWED_TAGS,
        clean_content_tags={"script", "style", "iframe", "object", "embed", "template", "noscript"},
        attributes=_ALLOWED_ATTRIBUTES,
        attribute_filter=_filter_attribute,
        url_schemes={"http", "https", "mailto", "data"},
        link_rel="noopener noreferrer",
        strip_comments=True,
    )
    # An <img> whose source was rejected would show as a broken-image icon.
    return _IMG_WITHOUT_SRC.sub("", cleaned)
