from sqlalchemy import select

from app.models import AuditLog, Inventory, Product
from tests.conftest import API, assert_error

NEW_PRODUCT = {
    "sku": "NEW-100",
    "name": "New Widget",
    "category": "Tools",
    "unit_price_cents": 2500,
}


def test_products_require_authentication(anon):
    assert_error(anon.get(f"{API}/products"), 401, "NOT_AUTHENTICATED")


def test_list_hides_inactive_and_totals_stock_across_warehouses(viewer):
    body = viewer.get(f"{API}/products").json()
    assert [p["sku"] for p in body["items"]] == ["DRL-1", "GLV-1"]
    assert body["total"] == 2
    assert body["items"][0]["total_quantity"] == 105
    assert body["items"][1]["total_quantity"] == 10


def test_search_matches_name_and_sku_case_insensitively(viewer):
    assert [
        p["sku"] for p in viewer.get(f"{API}/products", params={"q": "glov"}).json()["items"]
    ] == ["GLV-1"]
    assert [
        p["sku"] for p in viewer.get(f"{API}/products", params={"q": "drl-"}).json()["items"]
    ] == ["DRL-1"]


def test_search_treats_like_wildcards_literally(viewer):
    assert viewer.get(f"{API}/products", params={"q": "%"}).json()["total"] == 0
    assert viewer.get(f"{API}/products", params={"q": "_"}).json()["total"] == 0


def test_filter_by_category_and_stock(manager, viewer, world):
    assert [
        p["sku"]
        for p in viewer.get(f"{API}/products", params={"category": "Safety"}).json()["items"]
    ] == ["GLV-1"]
    created = manager.post(f"{API}/products", json=NEW_PRODUCT).json()
    in_stock = viewer.get(f"{API}/products", params={"in_stock": True}).json()["items"]
    out_of_stock = viewer.get(f"{API}/products", params={"in_stock": False}).json()["items"]
    assert created["sku"] not in [p["sku"] for p in in_stock]
    assert [p["sku"] for p in out_of_stock] == [created["sku"]]


def test_sort_and_pagination(viewer):
    desc = viewer.get(
        f"{API}/products", params={"sort": "unit_price_cents", "direction": "desc", "page_size": 1}
    ).json()
    assert [p["sku"] for p in desc["items"]] == ["DRL-1"]
    assert (desc["total"], desc["pages"], desc["page_size"]) == (2, 2, 1)
    second = viewer.get(
        f"{API}/products",
        params={"sort": "unit_price_cents", "direction": "desc", "page_size": 1, "page": 2},
    ).json()
    assert [p["sku"] for p in second["items"]] == ["GLV-1"]


def test_invalid_sort_and_page_size_are_rejected(viewer):
    assert_error(
        viewer.get(f"{API}/products", params={"sort": "password"}), 422, "VALIDATION_ERROR"
    )
    assert_error(viewer.get(f"{API}/products", params={"page_size": 101}), 422, "VALIDATION_ERROR")
    assert_error(viewer.get(f"{API}/products", params={"page": 0}), 422, "VALIDATION_ERROR")


def test_include_inactive_is_honoured_only_for_staff(manager, viewer):
    staff = manager.get(f"{API}/products", params={"include_inactive": True}).json()
    assert "OLD-1" in [p["sku"] for p in staff["items"]]
    other = viewer.get(f"{API}/products", params={"include_inactive": True}).json()
    assert "OLD-1" not in [p["sku"] for p in other["items"]]


def test_categories_lists_active_only(manager, viewer):
    manager.post(f"{API}/products", json={**NEW_PRODUCT, "category": "Zeta"})
    assert viewer.get(f"{API}/products/categories").json() == ["Safety", "Tools", "Zeta"]


def test_product_detail_shows_stock_per_warehouse(viewer, world):
    body = viewer.get(f"{API}/products/{world.drill.id}").json()
    assert body["sku"] == "DRL-1"
    assert {s["warehouse"]["code"]: s["quantity"] for s in body["stock"]} == {"CAL": 5, "TOR": 100}
    assert body["total_quantity"] == 105


def test_product_detail_invalid_and_unknown_ids(viewer):
    assert_error(viewer.get(f"{API}/products/not-a-uuid"), 422, "VALIDATION_ERROR")
    assert_error(
        viewer.get(f"{API}/products/00000000-0000-4000-8000-000000000000"), 404, "NOT_FOUND"
    )


def test_create_product_seeds_zero_stock_everywhere(manager, db):
    response = manager.post(f"{API}/products", json=NEW_PRODUCT)
    assert response.status_code == 201
    body = response.json()
    assert body["total_quantity"] == 0
    assert len(body["stock"]) == 2
    assert all(s["quantity"] == 0 for s in body["stock"])
    rows = db.scalars(select(Inventory).join(Product).where(Product.sku == "NEW-100")).all()
    assert len(rows) == 2


def test_viewer_cannot_change_catalog(viewer, world):
    assert_error(viewer.post(f"{API}/products", json=NEW_PRODUCT), 403, "FORBIDDEN")
    assert_error(
        viewer.patch(f"{API}/products/{world.drill.id}", json={"name": "Hacked"}), 403, "FORBIDDEN"
    )
    assert_error(viewer.delete(f"{API}/products/{world.drill.id}"), 403, "FORBIDDEN")


def test_duplicate_sku_is_rejected(manager):
    assert_error(
        manager.post(f"{API}/products", json={**NEW_PRODUCT, "sku": "DRL-1"}), 409, "DUPLICATE_SKU"
    )


def test_product_validation(manager):
    for bad in (
        {"sku": "lower-case"},
        {"unit_price_cents": -1},
        {"unit_price_cents": 19.99},
        {"unit_price_cents": "100"},
        {"name": "   "},
    ):
        assert_error(
            manager.post(f"{API}/products", json={**NEW_PRODUCT, **bad}), 422, "VALIDATION_ERROR"
        )


def test_update_product(manager, world, db):
    response = manager.patch(f"{API}/products/{world.drill.id}", json={"unit_price_cents": 2100})
    assert response.status_code == 200
    assert response.json()["unit_price_cents"] == 2100
    assert db.get(Product, world.drill.id).unit_price_cents == 2100
    assert db.scalar(select(AuditLog).where(AuditLog.action == "product.updated")) is not None


def test_only_admin_can_delete_and_delete_is_soft(admin, manager, world, db):
    assert_error(manager.delete(f"{API}/products/{world.drill.id}"), 403, "FORBIDDEN")
    assert admin.delete(f"{API}/products/{world.drill.id}").status_code == 204
    assert db.get(Product, world.drill.id).is_active is False
    assert "DRL-1" not in [p["sku"] for p in admin.get(f"{API}/products").json()["items"]]
    assert admin.get(f"{API}/products/{world.drill.id}").json()["is_active"] is False


def test_warehouses(viewer, world):
    body = viewer.get(f"{API}/warehouses").json()
    assert [w["code"] for w in body] == ["CAL", "TOR"]
    assert viewer.get(f"{API}/warehouses/{world.toronto.id}").json()["tax_rate_bps"] == 1300
    assert_error(
        viewer.get(f"{API}/warehouses/00000000-0000-4000-8000-000000000000"), 404, "NOT_FOUND"
    )


def test_customers_are_scoped_for_external_buyers(viewer, buyer_a):
    assert [c["code"] for c in viewer.get(f"{API}/customers").json()] == ["ACME", "BETA"]
    assert [c["code"] for c in buyer_a.get(f"{API}/customers").json()] == ["ACME"]


NEW_CUSTOMER = {"code": "NEW-1", "name": "New Co", "contact_email": "buy@new.example"}


def test_admin_creates_customer_with_audit(admin, world, db):
    response = admin.post(f"{API}/customers", json=NEW_CUSTOMER)
    assert response.status_code == 201
    assert response.json()["code"] == "NEW-1"
    entry = db.scalar(select(AuditLog).where(AuditLog.action == "customer.created"))
    assert entry.actor_user_id == world.admin.id
    assert entry.entity_id == response.json()["id"]


def test_only_admin_can_create_customers(manager, viewer, anon):
    assert_error(manager.post(f"{API}/customers", json=NEW_CUSTOMER), 403, "FORBIDDEN")
    assert_error(viewer.post(f"{API}/customers", json=NEW_CUSTOMER), 403, "FORBIDDEN")
    assert_error(anon.post(f"{API}/customers", json=NEW_CUSTOMER), 401, "NOT_AUTHENTICATED")


def test_customer_validation_and_duplicates(admin):
    assert admin.post(f"{API}/customers", json=NEW_CUSTOMER).status_code == 201
    assert_error(admin.post(f"{API}/customers", json=NEW_CUSTOMER), 409, "DUPLICATE_CUSTOMER")
    for bad in ({"code": "lower"}, {"name": " "}, {"contact_email": "nope"}, {"id": "x"}):
        response = admin.post(f"{API}/customers", json={**NEW_CUSTOMER, "code": "NEW-2", **bad})
        assert_error(response, 422, "VALIDATION_ERROR")
