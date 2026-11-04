from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, Response, status
from sqlalchemy import select

from app.deps import CurrentUser, DbSession, OperatorUser
from app.models import Payment
from app.schemas import PaymentCreate, PaymentOut
from app.services import orders as order_service
from app.services import payments as service

router = APIRouter(tags=["payments"])


@router.post(
    "/orders/{order_id}/payments",
    response_model=PaymentOut,
    status_code=status.HTTP_201_CREATED,
    responses={
        200: {"model": PaymentOut, "description": "Replay of an earlier idempotent request"}
    },
)
def create_payment(
    order_id: UUID,
    payload: PaymentCreate,
    response: Response,
    db: DbSession,
    user: OperatorUser,
    idempotency_key: Annotated[
        str, Header(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_.:\-]+$")
    ],
) -> Payment:
    """Run a simulated payment. A decline or timeout is a recorded outcome, not an HTTP error."""
    payment, replayed = service.create_payment(
        db, user, order_id, idempotency_key, payload.method_token
    )
    db.commit()
    if replayed:
        response.status_code = status.HTTP_200_OK
        response.headers["Idempotency-Replayed"] = "true"
    return payment


@router.get("/orders/{order_id}/payments", response_model=list[PaymentOut])
def list_order_payments(order_id: UUID, db: DbSession, user: CurrentUser) -> list[Payment]:
    order_service.get_visible_order(db, user, order_id)
    return list(
        db.scalars(select(Payment).where(Payment.order_id == order_id).order_by(Payment.created_at))
    )


@router.get("/payments/{payment_id}", response_model=PaymentOut)
def get_payment(payment_id: UUID, db: DbSession, user: CurrentUser) -> Payment:
    return service.get_visible_payment(db, user, payment_id)


@router.post("/payments/{payment_id}/settle", response_model=PaymentOut)
def settle_payment(payment_id: UUID, db: DbSession, user: OperatorUser) -> Payment:
    payment = service.settle_payment(db, user, payment_id)
    db.commit()
    return payment
