from pydantic import BaseModel, EmailStr, field_validator
from typing import Optional
from app.models.user import SystemRole


class LoginRequest(BaseModel):
    email: EmailStr
    password: str

    @field_validator("email")
    @classmethod
    def email_lowercase(cls, v: str) -> str:
        return v.lower().strip()


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: "UserBrief"


class RefreshRequest(BaseModel):
    refresh_token: str


class UserBrief(BaseModel):
    id: str
    email: str
    full_name: str
    active_role: Optional[str]
    kyc_completed: bool
    must_change_password: bool = False
    profile_photo_url: Optional[str]
    roles: list[str]
    can_sign: bool = False
    # Lets GET /auth/my-profiles show an inactive/completed project profile
    # disabled rather than omitting it silently. Always True for a normal
    # login response (get_current_user already rejects inactive users
    # before one could be issued), so existing consumers are unaffected.
    is_active: bool = True
    # Populated only for a project (PI) profile, so the profile switcher can
    # show which project a "<Name> PI…" identity belongs to. Both stay None
    # for a normal person identity — existing consumers ignore them.
    project_number: Optional[str] = None
    project_name: Optional[str] = None

    model_config = {"from_attributes": True}


class GoogleOAuthRequest(BaseModel):
    code: str
    redirect_uri: str


class SwitchRoleRequest(BaseModel):
    # A role NAME the caller already holds (see user_roles). Not restricted
    # to the SystemRole enum — custom roles from Role Management are valid.
    role: str
