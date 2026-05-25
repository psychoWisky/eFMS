from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.staticfiles import StaticFiles
import structlog
import os

from app.core.config import settings

# Import all models so SQLAlchemy can resolve relationships at startup
import app.models.user          # noqa: F401
import app.models.organization  # noqa: F401
import app.models.efms          # noqa: F401
import app.models.audit         # noqa: F401
import app.models.admin         # noqa: F401
import app.models.efms_extra    # noqa: F401
from app.core.exceptions import (
    AppException, app_exception_handler,
    validation_exception_handler, generic_exception_handler
)
from app.middleware.audit import AuditMiddleware
from app.api.v1.router import api_router

structlog.configure(
    wrapper_class=structlog.make_filtering_bound_logger(20),
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ],
)

logger = structlog.get_logger()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("AVFU eFMS API starting", version=settings.APP_VERSION, env=settings.ENVIRONMENT)
    yield
    logger.info("AVFU eFMS API shutting down")


app = FastAPI(
    title=settings.APP_NAME,
    version=settings.APP_VERSION,
    description="AVFU eFMS Backend API",
    docs_url="/docs" if settings.DEBUG else None,
    redoc_url="/redoc" if settings.DEBUG else None,
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(AuditMiddleware)

# Exception handlers
app.add_exception_handler(AppException, app_exception_handler)
app.add_exception_handler(RequestValidationError, validation_exception_handler)
app.add_exception_handler(Exception, generic_exception_handler)

# Routers
app.include_router(api_router)

# Serve uploaded files at /uploads/<filename>
_upload_dir = os.path.abspath(settings.UPLOAD_DIR)
os.makedirs(_upload_dir, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=_upload_dir), name="uploads")


@app.get("/health")
async def health():
    return {"status": "healthy", "version": settings.APP_VERSION, "app": settings.APP_NAME}
