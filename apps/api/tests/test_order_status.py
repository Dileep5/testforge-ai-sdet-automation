import pytest
from sqlalchemy import select

from app.models import AuditLog, Inventory, Order, OrderStatus, Payment, PaymentStatus
from app.services.orders import TRANSITIONS
from tests.conftest import API, assert_error


def _move(client, order_id, status, note=""):
    return client.patch(f"{API}/orders/{order_id}/status", json={"status": status, "note": note})


def test_full_lifecycle(manager, create_order, pay):
    order = create_order()
    assert order["allowed_transitions"] == ["CONFIRMED", "CANCELLED"]
    payment = pay(order["id"])
    confirmed = _move(manager, order["id"], "CONFIRMED").json()
    assert confirmed["status"] == "CONFIRMED"
    assert confirmed["allowed_transitions"] == ["SHIPPED", "CANCELLED"]
    assert manager.post(f"{API}/payments/{payment['id']}/settle").status_code == 200
    assert _move(manager, order["id"], "SHIPPED").json()["status"] == "SHIPPED"
    delivered = _move(manager, order["id"], "DELIVERED").json()
    assert delivered["status"] == "DELIVERED"
    assert delivered["allowed_transitions"] == []
    assert delivered["payment_status"] == "SETTLED"


def _force_status(db, order_id, status):
    db.get(Order, order_id).status = status
    db.commit()


@pytest.mark.parametrize(
    ("start", "target"),
    [
        (start, target)
        for start in OrderStatus
        for target in OrderStatus
        if target not in TRANSITIONS[start]
    ],
)
def test_every_disallowed_transition_is_rejected(manager, create_order, db, start, target):
    order = create_order()
    _force_status(db, order["id"], start)
    error = assert_error(_move(manager, order["id"], target.value), 409, "INVALID_TRANSITION")
    assert error["details"][0]["from"] == start.value
    db.expire_all()
    assert db.get(Order, order["id"]).status is start


def test_confirm_requires_live_payment(manager, create_order, pay):
    order = create_order()
    assert_error(_move(manager, order["id"], "CONFIRMED"), 409, "PAYMENT_REQUIRED")
    pay(order["id"], "sim_declined")
    assert_error(_move(manager, order["id"], "CONFIRMED"), 409, "PAYMENT_REQUIRED")


def test_ship_requires_settled_payment(manager, create_order, pay):
    order = create_order()
    pay(order["id"])
    _move(manager, order["id"], "CONFIRMED")
    assert_error(_move(manager, order["id"], "SHIPPED"), 409, "PAYMENT_NOT_SETTLED")


def test_cancel_restores_stock_and_voids_authorization(manager, create_order, pay, world, db):
    order = create_order(items=[{"product_id": str(world.drill.id), "quantity": 10}])
    payment = pay(order["id"])
    response = _move(manager, order["id"], "CANCELLED", "customer request")
    assert response.status_code == 200
    db.expire_all()
    stock = db.scalar(
        select(Inventory.quantity).where(
            Inventory.product_id == world.drill.id, Inventory.warehouse_id == world.toronto.id
        )
    )
    assert stock == 100
    stored = db.get(Payment, payment["id"])
    assert stored.status is PaymentStatus.VOIDED
    assert stored.voided_at is not None


def test_settled_order_cannot_be_cancelled(manager, create_order, pay, world, db):
    order = create_order()
    payment = pay(order["id"])
    manager.post(f"{API}/payments/{payment['id']}/settle")
    assert_error(_move(manager, order["id"], "CANCELLED"), 409, "REFUND_NOT_SUPPORTED")
    db.expire_all()
    assert db.get(Order, order["id"]).status is OrderStatus.PENDING


def test_viewer_cannot_change_status(viewer, create_order):
    order = create_order()
    assert_error(_move(viewer, order["id"], "CANCELLED"), 403, "FORBIDDEN")


def test_unknown_status_value_and_unknown_order(manager, create_order):
    order = create_order()
    assert_error(_move(manager, order["id"], "LOST"), 422, "VALIDATION_ERROR")
    assert_error(
        _move(manager, "00000000-0000-4000-8000-000000000000", "CANCELLED"), 404, "NOT_FOUND"
    )


def test_status_change_is_audited_with_note(manager, create_order, world, db):
    order = create_order()
    _move(manager, order["id"], "CANCELLED", "duplicate order")
    entry = db.scalar(select(AuditLog).where(AuditLog.action == "order.status_changed"))
    assert entry.actor_user_id == world.manager.id
    assert entry.details == {"from": "PENDING", "to": "CANCELLED", "note": "duplicate order"}
