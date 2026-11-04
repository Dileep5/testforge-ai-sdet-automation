from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Cookie, Response, status
from sqlalchemy import delete, select, update

from app.config import get_settings
from app.deps import COOKIE_NAME, ROLE_PERMISSIONS, AuthDep, DbSession
from app.errors import AppError
from app.models import User, UserSession, utc_now
from app.schemas import LoginRequest, SessionUserOut, UserOut
from app.security import hash_token, new_session_token, verify_password
from app.services import audit

router = APIRouter(prefix="/auth", tags=["auth"])


def _session_user(user: User, session: UserSession) -> SessionUserOut:
    return SessionUserOut(
        **UserOut.model_validate(user).model_dump(),
        permissions=ROLE_PERMISSIONS[user.role],
        session_expires_at=session.expires_at,
    )


@router.post("/login", response_model=SessionUserOut)
def login(payload: LoginRequest, response: Response, db: DbSession) -> SessionUserOut:
    settings = get_settings()
    user = db.scalar(select(User).where(User.email == payload.email.lower()))
    password_ok = verify_password(user.password_hash if user else None, payload.password)
    if user is None or not password_ok or not user.is_active:
        audit.record(
            db, user.id if user else None, "auth.login_failed", "user", payload.email.lower()
        )
        db.commit()
        # One message for every cause, so the response does not reveal which emails exist.
        raise AppError(401, "INVALID_CREDENTIALS", "Incorrect email or password")

    now = utc_now()
    db.execute(
        delete(UserSession).where(UserSession.user_id == user.id, UserSession.expires_at < now)
    )
    token = new_session_token()
    session = UserSession(
        user_id=user.id,
        token_hash=hash_token(token),
        expires_at=now + timedelta(seconds=settings.session_ttl_seconds),
    )
    db.add(session)
    audit.record(db, user.id, "auth.login", "user", user.id)
    db.commit()
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=settings.session_ttl_seconds,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    return _session_user(user, session)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    response: Response,
    db: DbSession,
    token: Annotated[str | None, Cookie(alias=COOKIE_NAME, include_in_schema=False)] = None,
) -> None:
    # Idempotent: logging out with a missing or stale cookie still clears it.
    if token:
        session = db.scalar(select(UserSession).where(UserSession.token_hash == hash_token(token)))
        if session is not None and session.revoked_at is None:
            db.execute(
                update(UserSession).where(UserSession.id == session.id).values(revoked_at=utc_now())
            )
            audit.record(db, session.user_id, "auth.logout", "user", session.user_id)
            db.commit()
    response.delete_cookie(COOKIE_NAME, path="/")


@router.get("/me", response_model=SessionUserOut)
def me(auth: AuthDep) -> SessionUserOut:
    return _session_user(auth.user, auth.session)
