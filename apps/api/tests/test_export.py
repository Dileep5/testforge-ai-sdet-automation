import csv
import io

from sqlalchemy import select

from app.models import AuditLog, Customer, Order
from app.services.orders import CSV_COLUMNS
from tests.conftest import API, assert_error


def _rows(response) -> list[dict]:
    return list(csv.DictReader(io.StringIO(response.text)))


def test_csv_values_match_the_database(manager, create_order, pay, world, db):
    order = create_order()
    pay(order["id"])
    response = manager.get(f"{API}/orders/export.csv")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert 'filename="orders.csv"' in response.headers["content-disposition"]
    assert response.text.splitlines()[0].split(",") == CSV_COLUMNS

    rows = _rows(response)
    assert len(rows) == 1
    row = rows[0]
    stored = db.get(Order, order["id"])
    assert row["order_number"] == stored.order_number
    assert row["customer_code"] == "ACME"
    assert row["warehouse_code"] == "TOR"
    assert row["status"] == "PENDING"
    assert row["payment_status"] == "AUTHORIZED"
    assert row["line_count"] == "1"
    assert int(row["subtotal_cents"]) == stored.subtotal_cents
    assert int(row["tax_cents"]) == stored.tax_cents
    assert int(row["total_cents"]) == stored.total_cents
    # 2 x 19.99 + 13% tax = 45.18
    assert row["total"] == "45.18"


def test_export_honours_filters_and_sort(manager, create_order, world):
    create_order(
        warehouse=world.calgary, items=[{"product_id": str(world.drill.id), "quantity": 1}]
    )
    create_order(items=[{"product_id": str(world.drill.id), "quantity": 9}])
    create_order(items=[{"product_id": str(world.drill.id), "quantity": 3}])
    response = manager.get(
        f"{API}/orders/export.csv",
        params={"warehouse_id": str(world.toronto.id), "sort": "total_cents", "direction": "asc"},
    )
    rows = _rows(response)
    assert [r["warehouse_code"] for r in rows] == ["TOR", "TOR"]
    assert int(rows[0]["total_cents"]) < int(rows[1]["total_cents"])


def test_export_with_no_matches_has_only_header(manager):
    response = manager.get(f"{API}/orders/export.csv", params={"status": "SHIPPED"})
    assert response.status_code == 200
    assert response.text.strip() == ",".join(CSV_COLUMNS)


def test_export_is_scoped_and_requires_auth(anon, buyer_a, create_order, world):
    create_order(customer=world.customer_a)
    create_order(customer=world.customer_b)
    assert [r["customer_code"] for r in _rows(buyer_a.get(f"{API}/orders/export.csv"))] == ["ACME"]
    assert_error(anon.get(f"{API}/orders/export.csv"), 401, "NOT_AUTHENTICATED")


def test_export_neutralises_spreadsheet_formulas(manager, create_order, db):
    customer = Customer(code="=EVIL", name="=HYPERLINK(1)", contact_email="x@x.example")
    db.add(customer)
    db.commit()
    create_order(customer=customer)
    row = _rows(manager.get(f"{API}/orders/export.csv"))[0]
    assert row["customer_code"] == "'=EVIL"
    assert row["customer_name"] == "'=HYPERLINK(1)"


def test_commas_and_quotes_survive_round_trip(manager, create_order, db):
    customer = Customer(code="ODD", name='Odd, "Quoted" Co', contact_email="o@o.example")
    db.add(customer)
    db.commit()
    create_order(customer=customer)
    assert _rows(manager.get(f"{API}/orders/export.csv"))[0]["customer_name"] == 'Odd, "Quoted" Co'


def test_export_is_audited(manager, create_order, world, db):
    create_order()
    manager.get(f"{API}/orders/export.csv")
    entry = db.scalar(select(AuditLog).where(AuditLog.action == "order.exported"))
    assert entry.actor_user_id == world.manager.id
    assert entry.details == {"rows": 1}
