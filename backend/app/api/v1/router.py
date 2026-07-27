from fastapi import APIRouter
from app.api.v1.endpoints import auth
from app.api.v1.endpoints.efms_files import router as efms_router, dispatch_router
from app.api.v1.endpoints.admin import router as admin_router
from app.api.v1.endpoints.docket import router as docket_router

api_router = APIRouter(prefix="/api/v1")

api_router.include_router(auth.router)
api_router.include_router(efms_router)
api_router.include_router(dispatch_router)
api_router.include_router(admin_router)
api_router.include_router(docket_router)
