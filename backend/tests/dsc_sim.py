"""A stand-in for Capricorn's local signing service, for tests only.

It does what pkiNetworkSignHash does: takes the document digest (hex) and
returns a Base64 PKCS#7/CMS signed with a private key — here a throw-away test
key instead of a USB token."""
import base64
import hashlib
from datetime import datetime, timedelta, timezone

from asn1crypto import cms as acms, x509 as ax509, algos
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.x509.oid import NameOID


def make_identity(common_name="Test Officer", org="AVFU Test", valid_days=365, start_days_ago=1):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.ORGANIZATION_NAME, org), x509.NameAttribute(NameOID.COMMON_NAME, common_name)])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=start_days_ago)).not_valid_after(now + timedelta(days=valid_days))
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=True, key_encipherment=False, data_encipherment=False,
                                         key_agreement=False, key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
            .sign(key, hashes.SHA256()))
    return key, cert


def sign_hash(hash_hex: str, key, cert) -> str:
    """What the signing application returns in response.data for pkiNetworkSignHash."""
    digest = bytes.fromhex(hash_hex)
    acert = ax509.Certificate.load(cert.public_bytes(serialization.Encoding.DER))
    attrs = acms.CMSAttributes([
        acms.CMSAttribute({"type": "content_type", "values": ["data"]}),
        acms.CMSAttribute({"type": "message_digest", "values": [digest]}),
        acms.CMSAttribute({"type": "signing_time", "values": [acms.Time({"utc_time": datetime.now(timezone.utc).replace(microsecond=0)})]}),
    ])
    to_sign = attrs.dump()                                  # DER SET, as the standard requires
    signature = key.sign(to_sign, padding.PKCS1v15(), hashes.SHA256())
    signer_info = acms.SignerInfo({
        "version": "v1",
        "sid": acms.SignerIdentifier({"issuer_and_serial_number": acms.IssuerAndSerialNumber({
            "issuer": acert.issuer, "serial_number": acert.serial_number})}),
        "digest_algorithm": algos.DigestAlgorithm({"algorithm": "sha256"}),
        "signed_attrs": attrs,
        "signature_algorithm": algos.SignedDigestAlgorithm({"algorithm": "sha256_rsa"}),
        "signature": signature,
    })
    signed_data = acms.SignedData({
        "version": "v1",
        "digest_algorithms": [algos.DigestAlgorithm({"algorithm": "sha256"})],
        "encap_content_info": {"content_type": "data"},
        "certificates": [acms.CertificateChoices({"certificate": acert})],
        "signer_infos": [signer_info],
    })
    return base64.b64encode(acms.ContentInfo({"content_type": "signed_data", "content": signed_data}).dump()).decode()


def sample_pdf(pages=2, text="Test document") -> bytes:
    """A small valid PDF."""
    import io
    from pyhanko.pdf_utils.writer import PdfFileWriter
    from pypdf import PdfWriter
    w = PdfWriter()
    for _ in range(pages):
        w.add_blank_page(width=595, height=842)
    buf = io.BytesIO()
    w.write(buf)
    return buf.getvalue()
