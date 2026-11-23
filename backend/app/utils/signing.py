"""Who may sign: the permission belongs to a post (role + place + designation)."""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User, UserRole
from app.utils.posts import desig_key
from app.utils.workspace import role_context


def is_active_post(user: User, ur: UserRole) -> bool:
    """Is `ur` the post the person is working in right now?"""
    estb, dept = role_context(user, ur)
    return (user.active_role == ur.role
            and (user.establishment_id, user.department_id) == (estb, dept)
            and desig_key(user.active_designation) == desig_key(ur.designation))


def post_can_sign(user: User, roles) -> bool:
    return any(ur.can_sign and is_active_post(user, ur) for ur in roles)


async def user_can_sign_now(db: AsyncSession, user: User) -> bool:
    roles = (await db.execute(select(UserRole).where(UserRole.user_id == user.id).execution_options(populate_existing=True))).scalars().all()
    return post_can_sign(user, roles)
