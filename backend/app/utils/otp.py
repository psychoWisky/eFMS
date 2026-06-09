"""Shared OTP helpers — used by auth and signature endpoints."""
import random, string, smtplib
from datetime import datetime, timezone, timedelta
from email.mime.text import MIMEText
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.models.efms_extra import OTP


def _gen_code() -> str:
    return "".join(random.choices(string.digits, k=6))


async def create_otp(db: AsyncSession, target: str, otp_type: str) -> str:
    code = "123456" if otp_type == "mobile" else _gen_code()
    otp = OTP(
        target=target,
        otp_type=otp_type,
        code=code,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
    )
    db.add(otp)
    await db.commit()
    return code


async def verify_otp(db: AsyncSession, target: str, otp_type: str, code: str) -> bool:
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(OTP).where(
            OTP.target == target,
            OTP.otp_type == otp_type,
            OTP.code == code,
            OTP.is_used == False,
            OTP.expires_at > now,
        ).order_by(OTP.created_at.desc()).limit(1)
    )
    otp = result.scalar_one_or_none()
    if not otp:
        return False
    otp.is_used = True
    await db.commit()
    return True


def send_email(to: str, subject: str, body: str) -> None:
    from app.core.config import settings
    if not settings.SMTP_USER or not settings.SMTP_PASSWORD:
        return
    msg = MIMEText(body, "plain")
    msg["Subject"] = subject
    msg["From"] = settings.SMTP_FROM
    msg["To"] = to
    try:
        with smtplib.SMTP(settings.SMTP_HOST, settings.SMTP_PORT, timeout=10) as s:
            s.starttls()
            s.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            s.sendmail(settings.SMTP_FROM, [to], msg.as_string())
    except Exception:
        pass
