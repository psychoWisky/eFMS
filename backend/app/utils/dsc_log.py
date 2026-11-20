"""DSC signing log: one file with every signing step and every failure.

Written to  <uploads folder's parent>/logs/dsc.log  (rotates at 2 MB, keeps 5).
Contains no PINs, private keys or document contents — only who, which file,
which step, and the error. Errors seen in the officer's browser (for example
"could not reach the signing application") are sent here too.
"""
import functools
import logging
import os
import traceback
from logging.handlers import RotatingFileHandler

from fastapi import HTTPException

from app.core.config import settings

_logger = logging.getLogger("efms.dsc")


def _setup() -> None:
    if _logger.handlers:
        return
    log_dir = os.path.join(os.path.dirname(os.path.abspath(settings.UPLOAD_DIR)), "logs")
    os.makedirs(log_dir, exist_ok=True)
    h = RotatingFileHandler(os.path.join(log_dir, "dsc.log"), maxBytes=2_000_000, backupCount=5, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    _logger.addHandler(h)
    _logger.setLevel(logging.INFO)
    _logger.propagate = True


def log_dir() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(settings.UPLOAD_DIR)), "logs")


def dsc_event(level: int, stage: str, **fields) -> None:
    try:
        _setup()
        _logger.log(level, "%s %s", stage, " ".join(f"{k}={v!r}" for k, v in fields.items() if v is not None))
    except Exception:  # noqa: BLE001 - logging must never break signing
        pass


def logged_step(stage: str):
    """Wrap a signing endpoint: log success, refusals (4xx) and crashes (with traceback)."""
    def deco(fn):
        @functools.wraps(fn)
        async def wrapper(*args, **kwargs):
            user = kwargs.get("user")
            ctx = dict(file=str(kwargs.get("file_id")), sig=str(kwargs.get("signature_id")) if kwargs.get("signature_id") else None,
                       user=str(getattr(user, "id", "")), name=getattr(user, "full_name", None))
            try:
                result = await fn(*args, **kwargs)
            except HTTPException as exc:
                dsc_event(logging.WARNING if exc.status_code < 500 else logging.ERROR, f"{stage}.refused",
                          status=exc.status_code, detail=exc.detail, **ctx)
                raise
            except Exception as exc:  # noqa: BLE001
                dsc_event(logging.ERROR, f"{stage}.crashed", error=f"{type(exc).__name__}: {exc}",
                          trace=traceback.format_exc().replace("\n", " | "), **ctx)
                raise
            dsc_event(logging.INFO, f"{stage}.ok", **ctx)
            return result
        return wrapper
    return deco
