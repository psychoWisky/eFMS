"""The AVFU letterhead used on generated PDFs (crest, university name in
Assamese and English, address, teal/gold rules) — the same design as the
Notesheet PDF in efms_files.download_notesheet. Kept here so other documents
(e.g. the FOC approval sheet) print on the identical letterhead.
"""
import base64
from io import BytesIO
from pathlib import Path

# <project>/backend/app/utils/letterhead.py → parents[3] = <project>/
_PROJECT_ROOT = Path(__file__).resolve().parents[3]


def letterhead_logo_html() -> str:
    """The crest as an inline <img>, downscaled so the data URI stays small.
    Prefers avfu_letterhead_logo.png (from the official blank letterhead),
    falls back to avfu_logo.png; empty string if neither exists."""
    logo_path = _PROJECT_ROOT / "avfu_letterhead_logo.png"
    if not logo_path.is_file():
        logo_path = _PROJECT_ROOT / "avfu_logo.png"
    if not logo_path.is_file():
        return ""
    try:
        try:
            from PIL import Image
            img = Image.open(logo_path)
            img.thumbnail((360, 360))
            buf = BytesIO()
            img.save(buf, format="PNG", optimize=True)
            data = buf.getvalue()
        except Exception:  # noqa: BLE001 - any decode/resize failure
            data = logo_path.read_bytes()
    except OSError:
        return ""
    b64 = base64.b64encode(data).decode("ascii")
    return f'<img class="lh-logo" width="88" src="data:image/png;base64,{b64}" alt="AVFU">'


# CSS for the letterhead block (plain CSS — not an f-string).
LETTERHEAD_CSS = """
.letterhead { width: 100%; border-collapse: collapse; }
.lh-logo-cell { width: 92px; vertical-align: middle; padding: 0; }
.lh-logo { height: auto; display: block; }
.lh-titles { vertical-align: middle; text-align: center; padding: 0 10px 0 2px; }
.lh-name-as {
    font-family: "Noto Sans Bengali", "Noto Serif Bengali", "Lohit Assamese",
                 "Lohit Bengali", "Nirmala UI", "Mukti Narrow", Arial, sans-serif;
    font-size: 18.5px; font-weight: 700; letter-spacing: 0; line-height: 1.45;
    color: #0A5757; margin: 0;
}
.lh-name-en { font-size: 16px; font-weight: 700; letter-spacing: 1px; line-height: 1.4; color: #0A5757; margin: 1px 0 0 0; }
.lh-addr { font-size: 11.5px; font-weight: 700; letter-spacing: 0.8px; color: #4A4A4A; margin: 3px 0 0 0; }
.lh-rule { border: none; border-top: 2.5px solid #0D6E6E; margin: 7px 0 0 0; }
.lh-rule-thin { border: none; border-top: 0.75px solid #C6902B; margin: 2px 0 0 0; }
"""


def letterhead_html(logo_html: str) -> str:
    return f"""
    <table class="letterhead" cellpadding="0" cellspacing="0">
        <tr>
            <td class="lh-logo-cell">{logo_html}</td>
            <td class="lh-titles">
                <div class="lh-name-as">অসম পশু চিকিৎসা আৰু মীন বিশ্ববিদ্যালয়</div>
                <div class="lh-name-en">ASSAM VETERINARY AND FISHERY UNIVERSITY</div>
                <div class="lh-addr">KHANAPARA, GUWAHATI, ASSAM &#8211; 781022</div>
            </td>
        </tr>
    </table>
    <hr class="lh-rule">
    <hr class="lh-rule-thin">
    """
