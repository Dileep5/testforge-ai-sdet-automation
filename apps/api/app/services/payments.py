import hashlib
import time
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.errors import AppError, not_found
from app.models import Order, OrderStatus, Payment, PaymentStatus, User, utc_now
from app.services import audit
from app.services.orders import scope_to_user

# The token alone decides the outcome, which makes every scenario deterministic.
_OUTCOMES: dict[str, tuple[PaymentStatus, str | None]] = {
    "sim_success": (PaymentStatus.AUTHORIZED, None),
    "sim_declined": (PaymentStatus.DECLINED, "SIMULATED_ISSUER_DECLINE"),
    "sim_timeout": (PaymentStatus.TIMED_OUT, "SIMULATED_GATEWAY_TIMEOUT"),
}
_PAYABLE = (OrderStatus.PENDING, OrderStatus.CONFIRMED)


def _fingerprint(order_id: UUID, method_token: str) -> str:
    return hashlib.sha256(f"{order_id}:{method_token}".encode()).hexdigest()


def _find_replay(
    db: Session, user: User, order_id: UUID, key: str, method_token: str
) -> Payment | None:
    existing = db.scalar(
        select(Payment).where(Payment.created_by_id == user.id, Payment.idempotency_key == key)
    )
    if existing is None:
        return None
    if existing.request_fingerprint != _fingerprint(order_id, method_token):
        raise AppError(
            409, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was used for a different request"
        )
    return existing


def create_payment(
    db: Session, user: User, order_id: UUID, key: str, method_token: str
) -> tuple[Payment, bool]:
    """Return the payment and whether it was replayed from an earlier request."""
    visible = db.scalar(scope_to_user(select(Order.id).where(Order.id == order_id), user))
    if visible is None:
        raise not_found("Order")

    replay = _find_replay(db, user, order_id, key, method_token)
    if replay is not None:
        return replay, True

    # Simulate the slow gateway before taking row locks so other requests are not blocked.
    if method_token == "sim_timeout":  # noqa: S105
        db.rollback()
        time.sleep(get_settings().payment_sim_timeout_ms / 1000)

    order = db.scalar(select(Order).where(Order.id == order_id).with_for_update())
    # A concurrent duplicate may have finished while this request waited for the lock.
    replay = _find_replay(db, user, order_id, key, method_token)
    if replay is not None:
        return replay, True

    if order.status not in _PAYABLE:
        raise AppError(
            409, "ORDER_NOT_PAYABLE", f"An order in status {order.status.value} cannot be paid"
        )
    live = db.scalar(
        select(Payment).where(
            Payment.order_id == order.id,
            Payment.status.in_((PaymentStatus.AUTHORIZED, PaymentStatus.SETTLED)),
        )
    )
    if live is not None:
        raise AppError(409, "ALREADY_PAID", "This order already has an active payment")

    status, reason = _OUTCOMES[method_token]
    payment = Payment(
        order_id=order.id,
        idempotency_key=key,
        request_fingerprint=_fingerprint(order_id, method_token),
        method_token=method_token,
        amount_cents=order.total_cents,
        status=status,
        failure_reason=reason,
        created_by_id=user.id,
        authorized_at=utc_now() if status is PaymentStatus.AUTHORIZED else None,
    )
    db.add(payment)
    try:
        db.flush()
    except IntegrityError as exc:
        # The same key raced on a different order: the row locks above do not cover that case.
        db.rollback()
        raise AppError(
            409, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was used for a different request"
        ) from exc
    audit.record(
        db,
        user.id,
        f"payment.{status.value.lower()}",
        "payment",
        payment.id,
        {"order_id": str(order.id), "amount_cents": payment.amount_cents},
    )
    return payment, False


def get_visible_payment(db: Session, user: User, payment_id: UUID) -> Payment:
    stmt = scope_to_user(
        select(Payment).join(Order, Payment.order_id == Order.id).where(Payment.id == payment_id),
        user,
    )
    payment = db.scalar(stmt)
    if payment is None:
        raise not_found("Payment")
    return payment


def settle_payment(db: Session, user: User, payment_id: UUID) -> Payment:
    stmt = scope_to_user(
        select(Payment).join(Order, Payment.order_id == Order.id).where(Payment.id == payment_id),
        user,
    ).with_for_update(of=Payment)
    payment = db.scalar(stmt)
    if payment is None:
        raise not_found("Payment")
    if payment.status is not PaymentStatus.AUTHORIZED:
        raise AppError(
            409,
            "INVALID_PAYMENT_STATE",
            f"A payment in status {payment.status.value} cannot be settled",
        )
    payment.status = PaymentStatus.SETTLED
    payment.settled_at = utc_now()
    audit.record(
        db,
        user.id,
        "payment.settled",
        "payment",
        payment.id,
        {"order_id": str(payment.order_id), "amount_cents": payment.amount_cents},
    )
    return payment
