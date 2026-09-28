"""Mobile OTP delivery via the Fast2SMS OTP API.

We generate and verify the OTP ourselves (same OTP table and checks as the
email OTP, including the testing bypass code); Fast2SMS only delivers it,
using the approved OTP template (FAST2SMS_OTP_TEMPLATE_ID = their `otp_id`).
Docs: https://docs.fast2sms.com/reference/send-otp
"""
import logging
import re
from typing import Optional

import httpx

from app.core.config import settings

log = logging.getLogger(__name__)

FAST2SMS_OTP_URL = "https://www.fast2sms.com/dev/otp/send"


class SmsSendError(Exception):
    """Fast2SMS refused or could not be reached."""


def sms_configured() -> bool:
    return bool(settings.FAST2SMS_API_KEY and settings.FAST2SMS_OTP_TEMPLATE_ID)


def normalize_indian_mobile(raw: Optional[str]) -> Optional[str]:
    """10-digit Indian mobile number, or None. Accepts spaces, dashes and a
    +91 / 91 / 0 prefix (the formats the user forms allow)."""
    if not raw:
        return None
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    return digits if len(digits) == 10 else None


def mask_mobile(mobile10: str) -> str:
    return "******" + mobile10[-4:]


async def send_otp_sms(mobile10: str, code: str, expiry_minutes: int = 10) -> None:
    """Send `code` to `mobile10` through the OTP template. Raises
    SmsSendError on any failure — callers decide how to surface it."""
    if not sms_configured():
        raise SmsSendError("SMS is not configured.")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                FAST2SMS_OTP_URL,
                headers={"authorization": settings.FAST2SMS_API_KEY},
                json={
                    "mobile": mobile10,
                    "otp_id": settings.FAST2SMS_OTP_TEMPLATE_ID,
                    "otp": code,
                    "otp_length": len(code),
                    "otp_expiry": expiry_minutes,
                },
            )
        data = r.json() if r.content else {}
    except (httpx.HTTPError, ValueError) as e:
        log.warning("Fast2SMS request failed: %s", type(e).__name__)
        raise SmsSendError("Could not reach the SMS service.") from e
    if r.status_code != 200 or not data.get("return"):
        # Never log the key; the provider's message is safe to log.
        log.warning("Fast2SMS refused OTP send: HTTP %s %s", r.status_code, data.get("message"))
        raise SmsSendError(str(data.get("message") or f"HTTP {r.status_code}"))
