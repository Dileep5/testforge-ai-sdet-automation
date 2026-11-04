from uuid import UUID

from fastapi import APIRouter, status
from sqlalchemy import select, update
from sqlalchemy.orm import joinedload

from app.deps import ROLE_PERMISSIONS, AdminUser, CurrentUser, DbSession
from app.errors import AppError, not_found
from app.models import Customer, Role, User, UserSession, utc_now
from app.schemas import RoleOut, UserCreate, UserOut, UserUpdate
from app.security import hash_password
from app.services import audit

router = APIRouter(tags=["users"])


def _get_user(db: DbSession, user_id: UUID) -> User:
    user = db.scalar(select(User).options(joinedload(User.customer)).where(User.id == user_id))
    if user is None:
        raise not_found("User")
    return user


@router.get("/roles", response_model=list[RoleOut])
def list_roles(_: CurrentUser) -> list[RoleOut]:
    return [RoleOut(name=role, permissions=perms) for role, perms in ROLE_PERMISSIONS.items()]


@router.get("/users", response_model=list[UserOut])
def list_users(db: DbSession, _: AdminUser) -> list[User]:
    return list(db.scalars(select(User).options(joinedload(User.customer)).order_by(User.email)))


@router.get("/users/{user_id}", response_model=UserOut)
def get_user(user_id: UUID, db: DbSession, _: AdminUser) -> User:
    return _get_user(db, user_id)


@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(payload: UserCreate, db: DbSession, admin: AdminUser) -> User:
    email = payload.email.lower()
    if payload.customer_id is not None:
        if payload.role is not Role.VIEWER:
            raise AppError(422, "VALIDATION_ERROR", "Customer accounts must have the VIEWER role")
        if db.get(Customer, payload.customer_id) is None:
            raise AppError(422, "INVALID_REFERENCE", "Customer does not exist")
    if db.scalar(select(User.id).where(User.email == email)) is not None:
        raise AppError(409, "DUPLICATE_EMAIL", "A user with this email already exists")
    user = User(
        email=email,
        full_name=payload.full_name,
        password_hash=hash_password(payload.password),
        role=payload.role,
        customer_id=payload.customer_id,
    )
    db.add(user)
    db.flush()
    audit.record(db, admin.id, "user.created", "user", user.id, {"role": user.role.value})
    db.commit()
    return _get_user(db, user.id)


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(user_id: UUID, payload: UserUpdate, db: DbSession, admin: AdminUser) -> User:
    user = _get_user(db, user_id)
    changes = payload.model_dump(exclude_unset=True, exclude_none=True)
    if user.id == admin.id and ("role" in changes or "is_active" in changes):
        raise AppError(409, "SELF_MODIFICATION", "You cannot change your own role or active status")
    if changes.get("role") not in (None, Role.VIEWER) and user.customer_id is not None:
        raise AppError(422, "VALIDATION_ERROR", "Customer accounts must have the VIEWER role")

    privileges_changed = (
        "role" in changes and changes["role"] is not user.role or changes.get("is_active") is False
    )
    for field, value in changes.items():
        setattr(user, field, value)
    if privileges_changed:
        # Existing sessions must not outlive the privileges they were granted under.
        db.execute(
            update(UserSession)
            .where(UserSession.user_id == user.id, UserSession.revoked_at.is_(None))
            .values(revoked_at=utc_now())
        )
    audit.record(
        db, admin.id, "user.updated", "user", user.id, {k: str(v) for k, v in changes.items()}
    )
    db.commit()
    return user
