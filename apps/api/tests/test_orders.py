from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from unittest.mock import patch

from sqlalchemy import func, select, update

from app.models import AuditLog, Inventory, Order, OrderItem
from app.money import tax_cents
from tests.conftest import API, assert_error


def _stock(db, world, product=None, warehouse=None) -> int:
    db.expire_all()
    return db.scalar(
        select(Inventory.quantity).where(
            Inventory.product_id == (product or world.drill).id,
            Inventory.warehouse_id == (warehouse or world.toronto).id,
        )
    )


def _payload(world, **overrides) -> dict:
    return {
        "customer_id": str(world.customer_a.id),
        "warehouse_id": str(world.toronto.id),
        "items": [{"product_id": str(world.drill.id), "quantity": 1}],
        **overrides,
    }


def test_multi_line_order_totals_match_database(manager, world, db):
    response = manager.post(
        f"{API}/orders",
        json=_payload(
            world,
            items=[
                {"product_id": str(world.drill.id), "quantity": 3},
                {"product_id": str(world.gloves.id), "quantity": 7},
            ],
            notes="  dock 4  ",
        ),
    )
    assert response.status_code == 201
    body = response.json()
    # 3 x 19.99 + 7 x 3.33 = 83.28, plus 13% tax of 10.8264 which rounds to 10.83.
    assert body["subtotal_cents"] == 8328
    assert body["tax_cents"] == 1083
    assert body["total_cents"] == 9411
    assert body["status"] == "PENDING"
    assert body["notes"] == "dock 4"
    assert body["order_number"].startswith("ORD-")
    assert {i["sku"]: i["line_total_cents"] for i in body["items"]} == {
        "DRL-1": 5997,
        "GLV-1": 2331,
    }

    order = db.scalar(select(Order).where(Order.order_number == body["order_number"]))
    assert (order.subtotal_cents, order.tax_cents, order.total_cents) == (8328, 1083, 9411)
    assert order.created_by_id == world.manager.id
    line_sum = db.scalar(
        select(func.sum(OrderItem.line_total_cents)).where(OrderItem.order_id == order.id)
    )
    assert line_sum == order.subtotal_cents


def test_order_decrements_only_its_warehouse_and_is_audited(create_order, world, db):
    order = create_order(items=[{"product_id": str(world.drill.id), "quantity": 4}])
    assert _stock(db, world) == 96
    assert _stock(db, world, warehouse=world.calgary) == 5
    entry = db.scalar(select(AuditLog).where(AuditLog.action == "order.created"))
    assert entry.entity_id == order["id"]
    assert entry.details["total_cents"] == order["total_cents"]


def test_tax_uses_warehouse_rate(create_order, world):
    order = create_order(
        warehouse=world.calgary, items=[{"product_id": str(world.drill.id), "quantity": 1}]
    )
    assert order["tax_rate_bps"] == 500
    assert order["tax_cents"] == tax_cents(1999, 500) == 100


def test_price_change_does_not_alter_existing_order(manager, create_order, world):
    order = create_order()
    manager.patch(f"{API}/products/{world.drill.id}", json={"unit_price_cents": 1})
    fresh = manager.get(f"{API}/orders/{order['id']}").json()
    assert fresh["total_cents"] == order["total_cents"]
    assert fresh["items"][0]["unit_price_cents"] == 1999


def test_client_cannot_supply_prices_or_totals(manager, world):
    response = manager.post(f"{API}/orders", json=_payload(world, total_cents=1))
    assert_error(response, 422, "VALIDATION_ERROR")
    response = manager.post(
        f"{API}/orders",
        json=_payload(
            world, items=[{"product_id": str(world.drill.id), "quantity": 1, "unit_price_cents": 1}]
        ),
    )
    assert_error(response, 422, "VALIDATION_ERROR")


def test_viewer_cannot_create_order(viewer, world, db):
    assert_error(viewer.post(f"{API}/orders", json=_payload(world)), 403, "FORBIDDEN")
    assert db.scalar(select(func.count()).select_from(Order)) == 0


def test_order_validation(manager, world):
    drill = str(world.drill.id)
    for bad in (
        {"items": []},
        {"items": [{"product_id": drill, "quantity": 0}]},
        {"items": [{"product_id": drill, "quantity": -3}]},
        {"items": [{"product_id": drill, "quantity": 1.5}]},
        {"items": [{"product_id": "nope", "quantity": 1}]},
        {"customer_id": "nope"},
        {"items": [{"product_id": drill, "quantity": 1}, {"product_id": drill, "quantity": 2}]},
    ):
        assert_error(
            manager.post(f"{API}/orders", json=_payload(world, **bad)), 422, "VALIDATION_ERROR"
        )


def test_unknown_references_are_rejected(manager, world):
    unknown = "00000000-0000-4000-8000-000000000000"
    for bad in (
        {"customer_id": unknown},
        {"warehouse_id": unknown},
        {"items": [{"product_id": unknown, "quantity": 1}]},
    ):
        assert_error(
            manager.post(f"{API}/orders", json=_payload(world, **bad)), 422, "INVALID_REFERENCE"
        )


def test_retired_product_cannot_be_ordered(manager, world):
    response = manager.post(
        f"{API}/orders",
        json=_payload(world, items=[{"product_id": str(world.retired.id), "quantity": 1}]),
    )
    assert_error(response, 422, "INVALID_REFERENCE")


def test_insufficient_stock_rolls_back_every_line(manager, world, db):
    response = manager.post(
        f"{API}/orders",
        json=_payload(
            world,
            items=[
                {"product_id": str(world.drill.id), "quantity": 5},
                {"product_id": str(world.gloves.id), "quantity": 11},
            ],
        ),
    )
    error = assert_error(response, 409, "INSUFFICIENT_STOCK")
    assert error["details"] == [
        {"product_id": str(world.gloves.id), "sku": "GLV-1", "requested": 11, "available": 10}
    ]
    assert _stock(db, world) == 100
    assert _stock(db, world, product=world.gloves) == 10
    assert db.scalar(select(func.count()).select_from(Order)) == 0


def test_failure_after_stock_change_rolls_back_whole_transaction(manager, world, db):
    with patch("app.services.orders.audit.record", side_effect=RuntimeError("boom")):
        response = manager.post(f"{API}/orders", json=_payload(world))
    assert_error(response, 500, "INTERNAL_ERROR")
    assert "boom" not in response.text
    assert _stock(db, world) == 100
    assert db.scalar(select(func.count()).select_from(Order)) == 0
    assert db.scalar(select(func.count()).select_from(OrderItem)) == 0


def test_concurrent_orders_cannot_oversell(manager, world, db):
    # Calgary has 5 drills and 8 buyers want 1 each: exactly 5 can succeed.
    payload = _payload(
        world,
        warehouse_id=str(world.calgary.id),
        items=[{"product_id": str(world.drill.id), "quantity": 1}],
    )
    with ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(pool.map(lambda _: manager.post(f"{API}/orders", json=payload), range(8)))
    codes = sorted(r.status_code for r in responses)
    assert codes == [201] * 5 + [409] * 3
    assert _stock(db, world, warehouse=world.calgary) == 0
    assert db.scalar(select(func.count()).select_from(Order)) == 5


def test_orders_with_overlapping_products_do_not_deadlock(manager, world, db):
    forward = _payload(
        world,
        items=[
            {"product_id": str(world.drill.id), "quantity": 1},
            {"product_id": str(world.gloves.id), "quantity": 1},
        ],
    )
    backward = _payload(world, items=list(reversed(forward["items"])))
    payloads = [forward, backward] * 4
    with ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(pool.map(lambda p: manager.post(f"{API}/orders", json=p), payloads))
    assert [r.status_code for r in responses] == [201] * 8
    assert _stock(db, world) == 92
    assert _stock(db, world, product=world.gloves) == 2


def _set_created_at(db, order_id, moment):
    db.execute(update(Order).where(Order.id == order_id).values(created_at=moment))
    db.commit()


def test_list_filters(manager, create_order, world, db):
    a = create_order()
    b = create_order(customer=world.customer_b, warehouse=world.calgary)
    c = create_order()
    _set_created_at(db, a["id"], datetime(2026, 1, 10, 23, 59, tzinfo=UTC))
    _set_created_at(db, b["id"], datetime(2026, 1, 11, 0, 0, tzinfo=UTC))
    _set_created_at(db, c["id"], datetime(2026, 2, 1, 12, 0, tzinfo=UTC))

    def ids(**params):
        response = manager.get(f"{API}/orders", params=params)
        assert response.status_code == 200, response.text
        return {o["id"] for o in response.json()["items"]}

    assert ids(date_to="2026-01-10") == {a["id"]}
    assert ids(date_from="2026-01-11", date_to="2026-01-11") == {b["id"]}
    assert ids(date_from="2026-01-11") == {b["id"], c["id"]}
    assert ids(warehouse_id=str(world.calgary.id)) == {b["id"]}
    assert ids(customer_id=str(world.customer_b.id)) == {b["id"]}
    assert ids(status="PENDING") == {a["id"], b["id"], c["id"]}
    assert ids(status="SHIPPED") == set()
    assert ids(q=a["order_number"]) == {a["id"]}
    assert ids(date_from="2030-01-01") == set()


def test_inverted_date_range_is_rejected(manager):
    response = manager.get(
        f"{API}/orders", params={"date_from": "2026-02-01", "date_to": "2026-01-01"}
    )
    assert_error(response, 422, "VALIDATION_ERROR")


def test_invalid_filter_values_are_rejected(manager):
    for params in (
        {"status": "LOST"},
        {"date_from": "yesterday"},
        {"warehouse_id": "x"},
        {"sort": "secret"},
    ):
        assert_error(manager.get(f"{API}/orders", params=params), 422, "VALIDATION_ERROR")


def test_sort_and_pagination_cover_every_row_once(manager, create_order, world):
    created = [
        create_order(items=[{"product_id": str(world.drill.id), "quantity": q}])
        for q in (3, 1, 2, 4, 5)
    ]
    seen = []
    for page in (1, 2, 3):
        body = manager.get(
            f"{API}/orders",
            params={"sort": "total_cents", "direction": "asc", "page": page, "page_size": 2},
        ).json()
        assert (body["total"], body["pages"]) == (5, 3)
        seen += [o["total_cents"] for o in body["items"]]
    assert seen == sorted(o["total_cents"] for o in created)
    beyond = manager.get(f"{API}/orders", params={"page": 99}).json()
    assert beyond["items"] == []
    assert beyond["total"] == 5


def test_summary_has_no_line_items_but_counts_them(manager, create_order):
    create_order()
    row = manager.get(f"{API}/orders").json()["items"][0]
    assert row["item_count"] == 1
    assert "items" not in row


def test_order_history_lists_actions_with_actor(manager, create_order, pay):
    order = create_order()
    pay(order["id"])
    manager.patch(f"{API}/orders/{order['id']}/status", json={"status": "CONFIRMED", "note": "ok"})
    history = manager.get(f"{API}/orders/{order['id']}/history").json()
    assert [h["action"] for h in history] == [
        "order.created",
        "payment.authorized",
        "order.status_changed",
    ]
    assert history[-1]["actor_name"] == "Manager"
    assert history[-1]["details"] == {"from": "PENDING", "to": "CONFIRMED", "note": "ok"}


def test_external_buyer_only_sees_own_orders(buyer_a, create_order, world):
    mine = create_order(customer=world.customer_a)
    other = create_order(customer=world.customer_b)
    assert [o["id"] for o in buyer_a.get(f"{API}/orders").json()["items"]] == [mine["id"]]
    assert buyer_a.get(f"{API}/orders/{mine['id']}").status_code == 200
    # 404, not 403: a buyer must not learn that another customer's order exists.
    assert_error(buyer_a.get(f"{API}/orders/{other['id']}"), 404, "NOT_FOUND")
    assert_error(buyer_a.get(f"{API}/orders/{other['id']}/history"), 404, "NOT_FOUND")
    assert_error(buyer_a.get(f"{API}/orders/{other['id']}/payments"), 404, "NOT_FOUND")
    # A filter for the other customer must not widen the buyer's scope.
    filtered = buyer_a.get(f"{API}/orders", params={"customer_id": str(world.customer_b.id)}).json()
    assert filtered["items"] == []


def test_the_latest_representable_date_filter_does_not_overflow(manager, create_order):
    # Regression: date_to=9999-12-31 raised OverflowError when adding a day, giving a 500.
    order = create_order()
    params = {"date_from": "0001-01-01", "date_to": "9999-12-31"}
    listed = manager.get(f"{API}/orders", params=params)
    assert listed.status_code == 200
    assert order["id"] in [item["id"] for item in listed.json()["items"]]
    assert manager.get(f"{API}/orders/export.csv", params=params).status_code == 200


def test_a_buyer_cannot_read_the_idempotency_key_used_to_pay_their_order(
    buyer_a, manager, world, create_order
):
    # Regression: the key was serialized in every payment, including for customer-scoped buyers.
    order = create_order(customer=world.customer_a)
    key = "secret-retry-key-1"
    response = manager.post(
        f"{API}/orders/{order['id']}/payments",
        json={"method_token": "sim_success"},
        headers={"Idempotency-Key": key},
    )
    assert response.status_code == 201
    assert key not in response.text
    assert key not in buyer_a.get(f"{API}/orders/{order['id']}").text
