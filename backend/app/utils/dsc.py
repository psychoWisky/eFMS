"""Digital Signature Certificate (DSC) signing of PDFs with a USB token.

How it works (hash signing — the token's private key never leaves the token):

  1. prepare_pdf_for_dsc()   the server adds an empty signature field (with a
                             visible box) to the PDF and computes the SHA-256
                             digest of the bytes that the signature covers.
  2. The officer's browser sends that digest to the Capricorn "Browser Signing
     Solution" running on their own PC (pkiNetworkSignHash, http://127.0.0.1:1620).
     The token signs it after the officer's PIN and returns a PKCS#7/CMS.
  3. embed_dsc_signature()   the server checks that the CMS really signs THIS
                             digest and embeds it into the PDF.

A PDF can carry many signatures: each later signer adds an incremental update,
so earlier signatures stay valid.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import concurrent.futures
import hashlib
import io
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from asn1crypto import cms as asn1_cms
from pyhanko.pdf_utils import text
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign import fields, signers
from pyhanko.sign.signers.pdf_byterange import PreparedByteRangeDigest
from pyhanko.sign.signers.pdf_signer import PdfSigner, PdfSignatureMetadata, PdfTBSDocument
from pyhanko.sign.validation import async_validate_pdf_signature
from pyhanko.stamp import TextStampStyle
from pyhanko_certvalidator.registry import SimpleCertificateStore

# DER bytes reserved for the CMS in the PDF. A CMS with a three-certificate
# chain is ~6–8 KB; this leaves ample room (it is stored as hex, so the PDF
# grows by twice this).
CMS_RESERVED_BYTES = 16 * 1024

BOX_WIDTH_PT = 200.0
BOX_HEIGHT_PT = 62.0


class DscError(ValueError):
    """A problem the user can act on (shown as-is)."""


@dataclass
class PreparedPdf:
    pdf_bytes: bytes            # the PDF with the empty signature placeholder
    digest: bytes               # SHA-256 over the signed byte ranges
    reserved_start: int
    reserved_end: int
    field_name: str

    @property
    def digest_hex(self) -> str:
        return self.digest.hex().upper()


@dataclass
class CertInfo:
    common_name: str
    organisation: Optional[str]
    serial_hex: str
    issuer: str
    not_before: datetime
    not_after: datetime
    fingerprint_sha256: str

    @property
    def expired(self) -> bool:
        return datetime.now(timezone.utc) > self.not_after

    @property
    def not_yet_valid(self) -> bool:
        return datetime.now(timezone.utc) < self.not_before


def _next_field_name(reader: PdfFileReader) -> str:
    """A signature field name no earlier signature uses (Signature1, 2, …)."""
    existing = set()
    try:
        for name, _value, _ref in fields.enumerate_sig_fields(reader):
            existing.add(name)
    except Exception:  # noqa: BLE001 - a PDF with no AcroForm yet
        pass
    n = 1
    while f"Signature{n}" in existing:
        n += 1
    return f"Signature{n}"


def prepare_pdf_for_dsc(
    pdf_bytes: bytes, *, page: int | str, pos_x_pct: float, pos_y_pct: float,
    signer_label: str, reason: str = "Approved in eFMS", when: Optional[datetime] = None,
) -> PreparedPdf:
    """Add an empty, visible signature field and return the digest to sign.

    page: 1-based page number, or "last". pos_*_pct: where the centre of the
    signature box goes, in percent of the page from the top-left."""
    when = when or datetime.now(timezone.utc)
    try:
        reader = PdfFileReader(io.BytesIO(pdf_bytes))
        w = IncrementalPdfFileWriter(io.BytesIO(pdf_bytes))
        n_pages = reader.root["/Pages"]["/Count"]
    except Exception as exc:  # noqa: BLE001
        raise DscError("This PDF could not be read, so it cannot be signed.") from exc
    if reader.encrypt_dict is not None:
        raise DscError("This PDF is password-protected and cannot be signed.")

    page_no = n_pages if page == "last" else int(page)
    if not 1 <= page_no <= n_pages:
        raise DscError(f"The document has {n_pages} page{'s' if n_pages != 1 else ''}; page {page_no} does not exist.")
    idx = page_no - 1
    try:
        page_obj = w.find_page_for_modification(idx)[0]
        box = [float(x) for x in page_obj["/MediaBox"]]
    except Exception:  # noqa: BLE001 - fall back to A4
        box = [0.0, 0.0, 595.0, 842.0]
    x0, y0, x1, y1 = box
    pw, ph = x1 - x0, y1 - y0
    bw, bh = min(BOX_WIDTH_PT, pw), min(BOX_HEIGHT_PT, ph)
    cx = x0 + pw * max(0.0, min(100.0, pos_x_pct)) / 100.0
    cy = y1 - ph * max(0.0, min(100.0, pos_y_pct)) / 100.0
    left = max(x0, min(x1 - bw, cx - bw / 2))
    bottom = max(y0, min(y1 - bh, cy - bh / 2))
    sig_box = (left, bottom, left + bw, bottom + bh)

    field_name = _next_field_name(reader)
    meta = PdfSignatureMetadata(
        field_name=field_name, md_algorithm="sha256", reason=reason,
        subfilter=fields.SigSeedSubFilter.PADES,
    )
    style = TextStampStyle(
        stamp_text="Digitally signed by\n%(who)s\nDate: %(date)s\n%(reason)s",
        text_box_style=text.TextBoxStyle(font_size=8),
        border_width=1,
    )
    # The signer object is only needed to describe the signature; the real
    # signature is made on the officer's token, so this one never signs.
    placeholder = _PlaceholderSigner()
    pdf_signer = PdfSigner(
        meta, signer=placeholder, stamp_style=style,
        new_field_spec=fields.SigFieldSpec(sig_field_name=field_name, on_page=idx, box=sig_box),
    )
    async def _go():
        return await pdf_signer.async_digest_doc_for_signing(
            w, bytes_reserved=CMS_RESERVED_BYTES * 2,
            appearance_text_params={"who": signer_label, "date": when.astimezone().strftime("%d-%m-%Y %H:%M %Z"), "reason": reason},
        )
    try:
        prepared, _tbs, out = _run(_go)
    except Exception as exc:  # noqa: BLE001
        raise DscError(f"Could not prepare this PDF for signing: {exc}") from exc
    out.seek(0)
    return PreparedPdf(
        pdf_bytes=out.read(), digest=prepared.document_digest,
        reserved_start=prepared.reserved_region_start, reserved_end=prepared.reserved_region_end,
        field_name=field_name,
    )


def _run(coro_fn):
    """Run one of pyHanko's async calls to completion — also when called from
    code that is already inside an event loop (it then runs in its own thread)."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro_fn())
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        return ex.submit(lambda: asyncio.run(coro_fn())).result()


class _PlaceholderSigner(signers.Signer):
    """Describes the signature to pyHanko without being able to sign: the real
    signer (the certificate on the officer's token) is not known until the
    signature exists."""
    def __init__(self):
        super().__init__(signing_cert=None, cert_registry=SimpleCertificateStore())

    async def async_sign_raw(self, data: bytes, digest_algorithm: str, dry_run=False) -> bytes:  # pragma: no cover
        raise RuntimeError("The placeholder signer never signs.")


def cms_from_b64(b64: str) -> bytes:
    try:
        raw = base64.b64decode("".join((b64 or "").split()), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise DscError("The signature returned by the signing application is not valid Base64.") from exc
    if not raw:
        raise DscError("The signing application returned an empty signature.")
    return raw


def embed_dsc_signature(prepared: PreparedPdf, cms_der: bytes) -> tuple[bytes, CertInfo]:
    """Embed the token's CMS into the prepared PDF, check that it really signs
    this document, and return (signed PDF, certificate details)."""
    if len(cms_der) > CMS_RESERVED_BYTES:
        raise DscError("The signature (with its certificate chain) is larger than the space reserved for it.")
    try:
        content = asn1_cms.ContentInfo.load(cms_der)
        signed = content["content"]
        if content["content_type"].native != "signed_data" or len(signed["signer_infos"]) != 1:
            raise ValueError
    except Exception as exc:  # noqa: BLE001
        raise DscError("The signing application did not return a valid PKCS#7 signature.") from exc

    attrs = signed["signer_infos"][0]["signed_attrs"]
    md = None
    if attrs and attrs.native:
        for a in attrs:
            if a["type"].native == "message_digest":
                md = bytes(a["values"][0].native)
    if md is None:
        raise DscError("The signature does not carry a message digest.")
    if md != prepared.digest:
        raise DscError("The signature is for a different document digest — nothing was signed. Please try again.")

    pdf_prep = PreparedByteRangeDigest(
        document_digest=prepared.digest, reserved_region_start=prepared.reserved_start,
        reserved_region_end=prepared.reserved_end,
    )
    out = io.BytesIO(prepared.pdf_bytes)
    out.seek(0, io.SEEK_END)
    try:
        PdfTBSDocument.finish_signing(out, pdf_prep, signature_cms=cms_der)
    except Exception as exc:  # noqa: BLE001
        raise DscError(f"The signature could not be added to the PDF: {exc}") from exc
    out.seek(0)
    signed_pdf = out.read()

    # Independent check of the finished PDF: the byte ranges must match the
    # digest and the CMS must verify against the signer's certificate.
    async def _check():
        r = PdfFileReader(io.BytesIO(signed_pdf))
        for emb in r.embedded_signatures:
            if emb.field_name == prepared.field_name:
                return await async_validate_pdf_signature(emb)
        return None
    status = _run(_check)
    if status is None:
        raise DscError("The signature was not found in the signed PDF.")
    if not (status.intact and status.valid):
        raise DscError("The signature does not verify against the document. Please try again.")
    return signed_pdf, _cert_info(status.signing_cert)


def _cert_info(cert) -> CertInfo:
    subject = cert.subject.native
    cn = subject.get("common_name") or subject.get("organization_name") or cert.subject.human_friendly
    if isinstance(cn, list):
        cn = ", ".join(cn)
    org = subject.get("organization_name")
    if isinstance(org, list):
        org = ", ".join(org)
    return CertInfo(
        common_name=str(cn), organisation=org,
        serial_hex=format(cert.serial_number, "X"),
        issuer=cert.issuer.human_friendly,
        not_before=cert["tbs_certificate"]["validity"]["not_before"].native,
        not_after=cert["tbs_certificate"]["validity"]["not_after"].native,
        fingerprint_sha256=hashlib.sha256(cert.dump()).hexdigest().upper(),
    )
