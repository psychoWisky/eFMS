from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response
import time
import structlog

logger = structlog.get_logger()


class AuditMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        start_time = time.time()
        response = await call_next(request)
        duration = round((time.time() - start_time) * 1000, 2)

        logger.info(
            "request",
            method=request.method,
            path=request.url.path,
            status_code=response.status_code,
            duration_ms=duration,
            ip=request.client.host if request.client else "unknown",
        )
        response.headers["X-Process-Time"] = str(duration)
        return response
