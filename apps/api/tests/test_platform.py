import json
from unittest.mock import patch

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError, OperationalError

from alembic import command
from app.db import engine
from app.main import app
from app.models import AuditLog, Base, Inventory, Order, OrderStatus, Payment
from app.seed import ORDER_COUNT, reset, seed
from tests.conftest import API, API_ROOT, alembic_config, assert_error


def test_health_needs_no_auth_or_database(anon):
    with patch("app.routers.health.SessionLocal", side_effect=AssertionError("must not be called")):
        response = anon.get(f"{API}/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_ready_reports_migration(anon):
    response = anon.get(f"{API}/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ready", "database": "ok", "migration": "0001"}


def test_ready_returns_503_when_database_is_down(anon):
    failure = OperationalError("SELECT 1", {}, Exception("connection refused to host-secret"))
    with patch("app.routers.health.SessionLocal", side_effect=failure):
        response = anon.get(f"{API}/ready")
    assert response.status_code == 503
    assert response.json()["status"] == "not_ready"
    assert "host-secret" not in response.text


def test_malformed_json_returns_400(manager):
    response = manager.post(
        f"{API}/orders", content="{not json", headers={"Content-Type": "application/json"}
    )
    assert_error(response, 400, "INVALID_JSON")


def test_missing_fields_are_named(manager):
    error = assert_error(manager.post(f"{API}/orders", json={}), 422, "VALIDATION_ERROR")
    assert {d["field"] for d in error["details"]} == {
        "body.customer_id",
        "body.warehouse_id",
        "body.items",
    }


def test_unknown_route_and_wrong_method_use_the_envelope(anon):
    assert_error(anon.get(f"{API}/nope"), 404, "NOT_FOUND")
    assert_error(anon.put(f"{API}/health"), 405, "METHOD_NOT_ALLOWED")


def test_unexpected_error_hides_internals(manager):
    with patch(
        "app.routers.orders.service.list_orders", side_effect=RuntimeError("db password=hunter2")
    ):
        response = manager.get(f"{API}/orders")
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "INTERNAL_ERROR"
    assert "hunter2" not in response.text
    assert "Traceback" not in response.text


def test_nul_byte_in_search_is_a_client_error(viewer):
    response = viewer.get(f"{API}/products", params={"q": "a\x00b"})
    assert_error(response, 422, "INVALID_DATA")


def test_sql_injection_text_is_treated_as_data(viewer):
    response = viewer.get(f"{API}/products", params={"q": "' OR 1=1; DROP TABLE orders; --"})
    assert response.status_code == 200
    assert response.json()["total"] == 0
    assert viewer.get(f"{API}/orders").status_code == 200


def test_security_headers_present(anon):
    response = anon.get(f"{API}/health")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-request-id"]


def test_dashboard_summary_counts_and_scope(manager, buyer_a, create_order, pay, world):
    paid = create_order(customer=world.customer_a)
    payment = pay(paid["id"])
    manager.post(f"{API}/payments/{payment['id']}/settle")
    create_order(customer=world.customer_b)
    summary = manager.get(f"{API}/dashboard/summary").json()
    assert summary["total_orders"] == 2
    assert summary["open_orders"] == 2
    assert summary["orders_by_status"]["PENDING"] == 2
    assert summary["settled_revenue_cents"] == paid["total_cents"]
    assert len(summary["recent_orders"]) == 2
    assert buyer_a.get(f"{API}/dashboard/summary").json()["total_orders"] == 1


def test_audit_log_is_admin_only_and_filterable(admin, manager, create_order):
    order = create_order()
    assert_error(manager.get(f"{API}/audit-logs"), 403, "FORBIDDEN")
    body = admin.get(
        f"{API}/audit-logs", params={"entity_type": "order", "entity_id": order["id"]}
    ).json()
    assert body["total"] == 1
    assert body["items"][0]["action"] == "order.created"
    assert body["items"][0]["actor_email"] == "manager@test.example"


def test_database_constraints_block_bad_writes_directly(create_order, world):
    order = create_order()
    statements = [
        "UPDATE inventory SET quantity = -1",
        "UPDATE orders SET total_cents = total_cents + 1",
        "UPDATE order_items SET line_total_cents = line_total_cents + 1",
        "UPDATE orders SET status = 'LOST'",
    ]
    for statement in statements:
        with engine.connect() as conn:
            try:
                conn.execute(text(statement))
            except IntegrityError:
                conn.rollback()
                continue
            raise AssertionError(f"Constraint did not block: {statement}")
    assert order["status"] == "PENDING"


def test_migrations_match_models():
    with engine.connect() as conn:
        diff = compare_metadata(MigrationContext.configure(conn), Base.metadata)
    assert diff == []


def test_migration_downgrade_and_upgrade_round_trip():
    command.downgrade(alembic_config(), "base")
    with engine.connect() as conn:
        tables = conn.scalar(
            text(
                "SELECT count(*) FROM pg_tables "
                "WHERE schemaname = 'public' AND tablename <> 'alembic_version'"
            )
        )
    command.upgrade(alembic_config(), "head")
    assert tables == 0


def _fingerprint_of_seed(db) -> list[tuple]:
    orders = db.execute(
        select(
            Order.id, Order.order_number, Order.status, Order.total_cents, Order.created_at
        ).order_by(Order.id)
    ).all()
    stock = db.execute(select(Inventory.id, Inventory.quantity).order_by(Inventory.id)).all()
    payments = db.execute(select(Payment.id, Payment.status).order_by(Payment.id)).all()
    return [tuple(r) for r in (*orders, *stock, *payments)]


def test_seed_is_deterministic_and_consistent(db):
    reset(db)
    counts = seed(db)
    db.commit()
    first = _fingerprint_of_seed(db)
    reset(db)
    seed(db)
    db.commit()
    db.expire_all()
    assert _fingerprint_of_seed(db) == first
    assert counts["orders"] == ORDER_COUNT

    orders = db.scalars(select(Order)).unique().all()
    assert len({o.status for o in orders}) == len(OrderStatus)
    for order in orders:
        assert sum(i.line_total_cents for i in order.items) == order.subtotal_cents
        assert order.total_cents == order.subtotal_cents + order.tax_cents
        if order.status in (OrderStatus.SHIPPED, OrderStatus.DELIVERED):
            assert order.payments[-1].status.value == "SETTLED"
        if order.status is OrderStatus.CONFIRMED:
            assert order.payments[-1].status.value == "AUTHORIZED"
        if order.status in (OrderStatus.PENDING, OrderStatus.CANCELLED):
            assert order.payments == []
    assert db.scalar(select(AuditLog).where(AuditLog.action == "order.created")) is not None


def test_committed_openapi_spec_matches_the_app():
    committed = json.loads((API_ROOT / "openapi.json").read_text())
    assert committed == json.loads(json.dumps(app.openapi()))


def test_openapi_documents_every_required_area_and_error_envelope():
    spec = app.openapi()
    paths = spec["paths"]
    for path in (
        "/api/v1/auth/login",
        "/api/v1/users",
        "/api/v1/products",
        "/api/v1/warehouses",
        "/api/v1/inventory/{inventory_id}",
        "/api/v1/orders",
        "/api/v1/orders/{order_id}/status",
        "/api/v1/orders/export.csv",
        "/api/v1/orders/{order_id}/payments",
        "/api/v1/payments/{payment_id}/settle",
        "/api/v1/health",
        "/api/v1/ready",
    ):
        assert path in paths
    assert "HTTPValidationError" not in spec["components"]["schemas"]
    for status in ("401", "403", "404", "409", "422"):
        ref = paths["/api/v1/orders"]["post"]["responses"][status]["content"]["application/json"][
            "schema"
        ]
        assert ref["$ref"].endswith("/ErrorResponse")
