from functools import lru_cache
from typing import List
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", case_sensitive=True, extra="ignore")

    # App
    APP_NAME: str = "AVFU eFMS"
    APP_VERSION: str = "1.0.0"
    ENVIRONMENT: str = "development"
    DEBUG: bool = True

    # Security
    SECRET_KEY: str = "change-this-secret-key-in-production-at-least-32-chars"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30

    # Database
    DATABASE_URL: str = "postgresql+asyncpg://postgres:password@localhost:5432/aau_db"
    DATABASE_POOL_SIZE: int = 20
    DATABASE_MAX_OVERFLOW: int = 10

    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"
    REDIS_CACHE_TTL: int = 3600

    # CORS
    ALLOWED_ORIGINS: str = "http://localhost:3000,http://localhost:3001"

    @property
    def cors_origins(self) -> List[str]:
        return [o.strip() for o in self.ALLOWED_ORIGINS.split(",")]

    # File Upload
    MAX_FILE_SIZE_MB: int = 10
    UPLOAD_DIR: str = "./uploads"
    ALLOWED_EXTENSIONS: str = "pdf,docx,xlsx,jpg,jpeg,png"

    @property
    def allowed_extensions_list(self) -> List[str]:
        return [e.strip() for e in self.ALLOWED_EXTENSIONS.split(",")]

    # Email
    SMTP_HOST: str = "smtp.gmail.com"
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = "AVFU eFMS <noreply@avfu.ac.in>"

    # Google OAuth
    GOOGLE_CLIENT_ID: str = ""
    GOOGLE_CLIENT_SECRET: str = ""

    # Celery
    CELERY_BROKER_URL: str = "redis://localhost:6379/1"
    CELERY_RESULT_BACKEND: str = "redis://localhost:6379/2"

    # Frontend
    AMS_FRONTEND_URL: str = "http://localhost:3000"
    EFMS_FRONTEND_URL: str = "http://localhost:3001"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
