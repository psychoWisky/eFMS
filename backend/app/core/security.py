from datetime import datetime, timedelta, timezone
from typing import Any, Optional
import re
import secrets
import string
import bcrypt
from jose import JWTError, jwt
from app.core.config import settings


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(plain_password.encode(), hashed_password.encode())


# ── Password policy ───────────────────────────────────────────────────────────
# Min 8 characters with at least one uppercase, one lowercase and one digit —
# the same baseline the signup form always advertised ("Min 8 characters"),
# made explicit and enforced server-side now that admins set passwords too.

PASSWORD_POLICY_MESSAGE = (
    "Password must be at least 8 characters and include an uppercase letter, "
    "a lowercase letter and a digit."
)


def is_password_policy_compliant(password: str) -> bool:
    return bool(
        len(password) >= 8
        and re.search(r"[A-Z]", password)
        and re.search(r"[a-z]", password)
        and re.search(r"\d", password)
    )


def generate_temp_password(length: int = 12) -> str:
    """Generate a strong random password that always satisfies the password
    policy above. Reused for both admin "Create User" and future admin
    password resets."""
    alphabet = string.ascii_letters + string.digits + "!@#$%&*"
    while True:
        pwd = "".join(secrets.choice(alphabet) for _ in range(length))
        if is_password_policy_compliant(pwd):
            return pwd


def create_access_token(subject: Any, extra_claims: dict | None = None) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    payload = {"sub": str(subject), "exp": expire, "type": "access"}
    if extra_claims:
        payload.update(extra_claims)
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_refresh_token(subject: Any) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    payload = {"sub": str(subject), "exp": expire, "type": "refresh"}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_password_reset_token(subject: Any, extra_claims: dict | None = None) -> str:
    """Short-lived, single-purpose JWT proving a Forgot Password OTP was
    successfully verified — minted by /auth/forgot-password/verify and
    consumed once by /auth/forgot-password/reset. Same create/verify pattern
    as create_access_token/create_refresh_token above (verify_token already
    accepts any token_type), just a third, distinct `type` value — this is
    the "secure server-verifiable reset context" standing in for a
    client-supplied `otp_verified: true` boolean, which would be trivially
    forgeable.

    Callers should pass extra_claims={"pwd_sig": <hash of the CURRENT
    hashed_password>} so /auth/forgot-password/reset can detect and reject
    replay of an already-used token: a JWT has no server-side "used" state
    by itself, but once the password changes, the stored fingerprint no
    longer matches, making a second use fail exactly like an expired token
    would — without a new database table just to track single-use tokens."""
    expire = datetime.now(timezone.utc) + timedelta(minutes=15)
    payload = {"sub": str(subject), "exp": expire, "type": "password_reset"}
    if extra_claims:
        payload.update(extra_claims)
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_token(token: str) -> dict:
    return jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])


def verify_token_payload(token: str, token_type: str = "access") -> Optional[dict]:
    """Like verify_token, but returns the full decoded payload instead of
    just the `sub` claim — for callers (e.g. the password-reset flow) that
    need to read an additional custom claim after confirming the token's
    type and signature/expiry are valid."""
    try:
        payload = decode_token(token)
        if payload.get("type") != token_type:
            return None
        return payload
    except JWTError:
        return None


def verify_token(token: str, token_type: str = "access") -> Optional[str]:
    try:
        payload = decode_token(token)
        if payload.get("type") != token_type:
            return None
        return payload.get("sub")
    except JWTError:
        return None
