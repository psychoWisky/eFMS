from pydantic import BaseModel, EmailStr, field_validator
from typing import Optional
from datetime import date
from app.models.user import Gender, SystemRole
import uuid


class KYCProfileUpdate(BaseModel):
    first_name: str
    last_name: str
    date_of_birth: date
    gender: Gender
    employee_code: str
    designation: str
    establishment_id: uuid.UUID
    department_id: uuid.UUID
    mobile: str

    @field_validator("employee_code")
    @classmethod
    def validate_employee_code(cls, v: str) -> str:
        return v

    @field_validator("mobile")
    @classmethod
    def validate_mobile(cls, v: str) -> str:
        digits = v.replace("+91", "").replace(" ", "").replace("-", "")
        if not digits.isdigit() or len(digits) != 10:
            raise ValueError("Mobile number must be 10 digits")
        return v


class UserProfileResponse(BaseModel):
    id: str
    email: str
    first_name: Optional[str]
    last_name: Optional[str]
    full_name: str
    date_of_birth: Optional[date]
    gender: Optional[Gender]
    mobile: Optional[str]
    employee_code: Optional[str]
    designation: Optional[str]
    establishment_id: Optional[str]
    department_id: Optional[str]
    profile_photo_url: Optional[str]
    active_role: Optional[SystemRole]
    kyc_completed: bool

    model_config = {"from_attributes": True}
