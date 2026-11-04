from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import Cookie, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.config import get_settings
from app.db import get_db
from app.errors import AppError
from app.models import Role, User, UserSession, utc_now
from app.security import hash_token

DbSession = Annotated[Session, Depends(get_db)]

COOKIE_NAME = get_settings().session_cookie_name

ROLE_PERMISSIONS: dict[Role, list[str]] = {
    Role.ADMIN: [
        "audit:read",
        "inventory:write",
        "orders:write",
        "payments:write",
        "products:delete",
        "products:write",
        "users:manage",
    ],
    Role.MANAGER: ["inventory:write", "orders:write", "payments:write", "products:write"],
    Role.VIEWER: [],
}


@dataclass
class AuthContext:
    user: User
    session: UserSession


def get_auth_context(
    db: DbSession,
    token: Annotated[str | None, Cookie(alias=COOKIE_NAME, include_in_schema=False)] = None,
) -> AuthContext:
    if not token:
        raise AppError(401, "NOT_AUTHENTICATED", "Authentication is required")
    record = db.scalar(
        select(UserSession)
        .options(joinedload(UserSession.user))
        .where(UserSession.token_hash == hash_token(token))
    )
    if record is None or record.revoked_at is not None or not record.user.is_active:
        raise AppError(401, "INVALID_SESSION", "Your session is no longer valid")
    if record.expires_at <= utc_now():
        raise AppError(401, "SESSION_EXPIRED", "Your session has expired, please sign in again")
    return AuthContext(user=record.user, session=record)


AuthDep = Annotated[AuthContext, Depends(get_auth_context)]


def get_current_user(auth: AuthDep) -> User:
    return auth.user


CurrentUser = Annotated[User, Depends(get_current_user)]


def require_roles(*roles: Role) -> Callable[[User], User]:
    def checker(user: CurrentUser) -> User:
        if user.role not in roles:
            raise AppError(403, "FORBIDDEN", "You do not have permission to perform this action")
        return user

    return checker


AdminUser = Annotated[User, Depends(require_roles(Role.ADMIN))]
OperatorUser = Annotated[User, Depends(require_roles(Role.ADMIN, Role.MANAGER))]
