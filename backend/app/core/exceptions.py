from fastapi import Request, status
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
import structlog

logger = structlog.get_logger()


class AppException(Exception):
    def __init__(self, status_code: int, message: str, detail: str | None = None):
        self.status_code = status_code
        self.message = message
        self.detail = detail


async def app_exception_handler(request: Request, exc: AppException) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"success": False, "message": exc.message, "detail": exc.detail},
    )


async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    errors = []
    for error in exc.errors():
        field = ".".join(str(loc) for loc in error["loc"] if loc != "body")
        errors.append({"field": field, "message": _humanize_error(error)})
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={
            "success": False,
            "message": "Please check the form fields and try again",
            "errors": errors,
        },
    )


async def generic_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.error("Unhandled exception", exc=str(exc), path=request.url.path)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "success": False,
            "message": "Something went wrong on our end. Please try again shortly.",
        },
    )


def _humanize_error(error: dict) -> str:
    msg_map = {
        "value_error": error.get("msg", "Invalid value").replace("Value error, ", ""),
        "missing": "This field is required",
        "string_too_short": f"Must be at least {error.get('ctx', {}).get('min_length', '')} characters",
        "string_too_long": f"Cannot exceed {error.get('ctx', {}).get('max_length', '')} characters",
        "int_parsing": "Must be a valid number",
        "email": "Please enter a valid email address",
    }
    error_type = error.get("type", "")
    return msg_map.get(error_type, error.get("msg", "Invalid value"))
