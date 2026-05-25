from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from app.db.base import get_db
from app.core.security import verify_token
from app.models.user import User, SystemRole

bearer_scheme = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user_id = verify_token(credentials.credentials, token_type="access")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    result = await db.execute(select(User).options(selectinload(User.roles)).where(User.id == user_id, User.is_active == True))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account not found or inactive",
        )

    return user


async def get_current_verified_user(
    current_user: User = Depends(get_current_user),
) -> User:
    if not current_user.is_verified:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Email not verified",
        )
    return current_user


async def require_kyc(
    current_user: User = Depends(get_current_verified_user),
) -> User:
    if not current_user.kyc_completed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Please complete your profile (KYC) before accessing this feature",
        )
    return current_user


def require_roles(*roles: SystemRole):
    async def role_checker(current_user: User = Depends(require_kyc)) -> User:
        user_roles = {r.role for r in current_user.roles if r.is_active}
        if not any(r in user_roles for r in roles):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Access denied. Required role: {', '.join(r.value for r in roles)}",
            )
        return current_user
    return role_checker
