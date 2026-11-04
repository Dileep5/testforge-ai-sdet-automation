from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import func, select

from app.models import AuditLog, Payment, PaymentStatus
from tests.conftest import API, assert_error


def _post(client, order_id, token="sim_success", key="key-00000001"):
    return client.post(
        f"{API}/orders/{order_id}/payments",
        json={"method_token": token},
        headers={"Idempotency-Key": key},
    )


def test_success_authorizes_for_the_server_side_total(manager, create_order, world, db):
    order = create_order()
    response = _post(manager, order["id"])
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "AUTHORIZED"
    assert body["amount_cents"] == order["total_cents"]
    assert body["authorized_at"] is not None
    assert body["settled_at"] is None
    assert "request_fingerprint" not in body
    stored = db.get(Payment, body["id"])
    assert stored.status is PaymentStatus.AUTHORIZED
    assert stored.created_by_id == world.manager.id


def test_declined_is_recorded_and_can_be_retried(manager, create_order, db):
    order = create_order()
    declined = _post(manager, order["id"], "sim_declined", "key-declined-1")
    assert declined.status_code == 201
    assert declined.json()["status"] == "DECLINED"
    assert declined.json()["failure_reason"] == "SIMULATED_ISSUER_DECLINE"
    assert declined.json()["authorized_at"] is None
    retry = _post(manager, order["id"], "sim_success", "key-declined-2")
    assert retry.status_code == 201
    assert retry.json()["status"] == "AUTHORIZED"
    assert db.scalar(select(func.count()).select_from(Payment)) == 2


def test_timeout_is_recorded_and_can_be_retried(manager, create_order):
    order = create_order()
    timed_out = _post(manager, order["id"], "sim_timeout", "key-timeout-1")
    assert timed_out.status_code == 201
    assert timed_out.json()["status"] == "TIMED_OUT"
    assert timed_out.json()["failure_reason"] == "SIMULATED_GATEWAY_TIMEOUT"
    assert (
        _post(manager, order["id"], "sim_success", "key-timeout-2").json()["status"] == "AUTHORIZED"
    )


def test_replay_returns_original_without_creating_another(manager, create_order, db):
    order = create_order()
    first = _post(manager, order["id"])
    second = _post(manager, order["id"])
    assert (first.status_code, second.status_code) == (201, 200)
    assert second.headers["idempotency-replayed"] == "true"
    assert "idempotency-replayed" not in first.headers
    assert second.json() == first.json()
    assert db.scalar(select(func.count()).select_from(Payment)) == 1
    assert db.scalar(select(func.count()).where(AuditLog.action == "payment.authorized")) == 1


def test_replay_of_failed_attempt_keeps_the_failure(manager, create_order):
    order = create_order()
    first = _post(manager, order["id"], "sim_declined")
    second = _post(manager, order["id"], "sim_declined")
    assert second.status_code == 200
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["status"] == "DECLINED"


def test_same_key_with_different_request_conflicts(manager, create_order, world):
    order = create_order()
    other = create_order()
    _post(manager, order["id"])
    assert_error(_post(manager, order["id"], "sim_declined"), 409, "IDEMPOTENCY_KEY_REUSED")
    assert_error(_post(manager, other["id"]), 409, "IDEMPOTENCY_KEY_REUSED")


def test_keys_are_scoped_per_user(manager, admin, create_order, db):
    order = create_order()
    declined = _post(manager, order["id"], "sim_declined")
    other_user = _post(admin, order["id"], "sim_declined")
    assert other_user.status_code == 201
    assert other_user.json()["id"] != declined.json()["id"]
    assert db.scalar(select(func.count()).select_from(Payment)) == 2


def test_concurrent_duplicates_create_one_payment(manager, create_order, db):
    order = create_order()
    with ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(pool.map(lambda _: _post(manager, order["id"]), range(8)))
    assert sorted(r.status_code for r in responses) == [200] * 7 + [201]
    assert len({r.json()["id"] for r in responses}) == 1
    assert db.scalar(select(func.count()).select_from(Payment)) == 1


def test_concurrent_different_keys_create_one_live_payment(manager, create_order, db):
    order = create_order()
    with ThreadPoolExecutor(max_workers=6) as pool:
        responses = list(
            pool.map(lambda i: _post(manager, order["id"], key=f"key-race-{i:04d}"), range(6))
        )
    assert sorted(r.status_code for r in responses) == [201] + [409] * 5
    live = db.scalar(
        select(func.count()).select_from(Payment).where(Payment.status == PaymentStatus.AUTHORIZED)
    )
    assert live == 1


def test_second_payment_on_paid_order_is_rejected(manager, create_order):
    order = create_order()
    _post(manager, order["id"])
    assert_error(_post(manager, order["id"], key="key-00000002"), 409, "ALREADY_PAID")


def test_cancelled_order_cannot_be_paid(manager, create_order):
    order = create_order()
    manager.patch(f"{API}/orders/{order['id']}/status", json={"status": "CANCELLED"})
    assert_error(_post(manager, order["id"]), 409, "ORDER_NOT_PAYABLE")


def test_settlement(manager, create_order, pay, db):
    payment = pay(create_order()["id"])
    response = manager.post(f"{API}/payments/{payment['id']}/settle")
    assert response.status_code == 200
    assert response.json()["status"] == "SETTLED"
    assert response.json()["settled_at"] is not None
    stored = db.get(Payment, payment["id"])
    assert stored.status is PaymentStatus.SETTLED
    assert db.scalar(select(AuditLog).where(AuditLog.action == "payment.settled")) is not None


def test_only_authorized_payments_can_settle(manager, create_order, pay):
    declined = pay(create_order()["id"], "sim_declined")
    assert_error(
        manager.post(f"{API}/payments/{declined['id']}/settle"), 409, "INVALID_PAYMENT_STATE"
    )
    authorized = pay(create_order()["id"])
    assert manager.post(f"{API}/payments/{authorized['id']}/settle").status_code == 200
    assert_error(
        manager.post(f"{API}/payments/{authorized['id']}/settle"), 409, "INVALID_PAYMENT_STATE"
    )


def test_viewer_cannot_pay_or_settle(viewer, create_order, pay):
    order = create_order()
    assert_error(_post(viewer, order["id"]), 403, "FORBIDDEN")
    payment = pay(order["id"])
    assert_error(viewer.post(f"{API}/payments/{payment['id']}/settle"), 403, "FORBIDDEN")
    assert viewer.get(f"{API}/payments/{payment['id']}").status_code == 200


def test_idempotency_key_is_required_and_validated(manager, create_order):
    order = create_order()
    url = f"{API}/orders/{order['id']}/payments"
    body = {"method_token": "sim_success"}
    error = assert_error(manager.post(url, json=body), 422, "VALIDATION_ERROR")
    assert "idempotency-key" in error["details"][0]["field"]
    for bad in ("short", "has spaces in it", "x" * 129):
        assert_error(
            manager.post(url, json=body, headers={"Idempotency-Key": bad}), 422, "VALIDATION_ERROR"
        )


def test_card_data_and_unknown_tokens_are_rejected(manager, create_order):
    order = create_order()
    url = f"{API}/orders/{order['id']}/payments"
    headers = {"Idempotency-Key": "key-00000009"}
    for body in (
        {"method_token": "tok_live_real"},
        {"method_token": "sim_success", "card_number": "not-a-real-card"},
        {"method_token": "sim_success", "amount_cents": 1},
    ):
        assert_error(manager.post(url, json=body, headers=headers), 422, "VALIDATION_ERROR")


def test_external_buyer_cannot_see_other_customers_payments(buyer_a, create_order, pay, world):
    mine = pay(create_order(customer=world.customer_a)["id"])
    other = pay(create_order(customer=world.customer_b)["id"])
    assert buyer_a.get(f"{API}/payments/{mine['id']}").status_code == 200
    assert_error(buyer_a.get(f"{API}/payments/{other['id']}"), 404, "NOT_FOUND")
    assert [p["id"] for p in buyer_a.get(f"{API}/orders/{mine['order_id']}/payments").json()] == [
        mine["id"]
    ]
