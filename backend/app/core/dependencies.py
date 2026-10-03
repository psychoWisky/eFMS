from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from app.db.base import get_db
from app.core.security import verify_token
from app.models.user import User, UserRole, SystemRole

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

    result = await db.execute(
        select(User)
        .options(
            selectinload(User.roles).selectinload(UserRole.department),
            selectinload(User.roles).selectinload(UserRole.establishment),
            selectinload(User.department),
            selectinload(User.establishment),
        )
        .where(User.id == user_id)
    )
    user = result.scalar_one_or_none()

    # A retired person (deactivated with the reason "retired") is let in with
    # limited access — see forbid_retired / require_roles. Everyone else who
    # is inactive stays locked out.
    if not user or not (user.is_active or user.is_retired):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User account not found or inactive",
        )

    return user


async def get_current_verified_user(
    current_user: User = Depends(get_current_user),
) -> User:
    return current_user


RETIRED_MESSAGE = (
    "Your account is retired. You can open and act on the files sent to you in your Docket, "
    "but you cannot use this feature."
)


async def forbid_retired(current_user: User = Depends(get_current_verified_user)) -> User:
    """For everything a retired person may not do: creating files, My Files,
    search, tracking history. They keep the Docket and the files in it."""
    if current_user.is_retired:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=RETIRED_MESSAGE)
    return current_user


async def require_password_changed(
    current_user: User = Depends(get_current_verified_user),
) -> User:
    if current_user.must_change_password:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "password_change_required", "message": "You must change your temporary password before continuing."},
        )
    return current_user


async def require_kyc(
    current_user: User = Depends(require_password_changed),
) -> User:
    if not current_user.kyc_completed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Please complete your profile (KYC) before accessing this feature",
        )
    return current_user


def require_roles(*roles: SystemRole):
    async def role_checker(current_user: User = Depends(require_kyc)) -> User:
        if current_user.is_retired:  # a retired person has no administrative access, whatever roles remain on file
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=RETIRED_MESSAGE)
        user_roles = {r.role for r in current_user.roles}
        if not any(r in user_roles for r in roles):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Access denied. Required role: {', '.join(r.value for r in roles)}",
            )
        return current_user
    return role_checker
