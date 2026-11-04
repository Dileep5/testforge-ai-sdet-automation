from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import select

from app.models import AuditLog, Inventory
from tests.conftest import API, assert_error


def _row(db, world, product=None, warehouse=None) -> Inventory:
    return db.scalar(
        select(Inventory).where(
            Inventory.product_id == (product or world.drill).id,
            Inventory.warehouse_id == (warehouse or world.toronto).id,
        )
    )


def _update(client, row, quantity, version=None, reason="cycle count"):
    return client.patch(
        f"{API}/inventory/{row.id}",
        json={
            "quantity": quantity,
            "expected_version": version if version is not None else row.version,
            "reason": reason,
        },
    )


def test_list_excludes_retired_and_filters_by_warehouse(viewer, world):
    body = viewer.get(f"{API}/inventory", params={"warehouse_id": str(world.calgary.id)}).json()
    assert {(r["product"]["sku"], r["quantity"]) for r in body["items"]} == {
        ("DRL-1", 5),
        ("GLV-1", 0),
    }
    assert body["total"] == 2


def test_search_and_low_stock_filter(viewer):
    found = viewer.get(f"{API}/inventory", params={"q": "gloves"}).json()
    assert {r["product"]["sku"] for r in found["items"]} == {"GLV-1"}
    low = viewer.get(f"{API}/inventory", params={"low_stock": True}).json()
    assert {(r["product"]["sku"], r["warehouse"]["code"]) for r in low["items"]} == {
        ("DRL-1", "CAL"),
        ("GLV-1", "CAL"),
        ("GLV-1", "TOR"),
    }


def test_manager_updates_quantity_with_audit(manager, world, db):
    row = _row(db, world)
    response = _update(manager, row, 77)
    assert response.status_code == 200
    assert response.json()["quantity"] == 77
    assert response.json()["version"] == row.version + 1
    db.expire_all()
    assert _row(db, world).quantity == 77
    entry = db.scalar(select(AuditLog).where(AuditLog.action == "inventory.updated"))
    assert entry.actor_user_id == world.manager.id
    assert entry.details == {"from": 100, "to": 77, "reason": "cycle count"}


def test_viewer_and_anonymous_cannot_update(viewer, anon, world, db):
    row = _row(db, world)
    assert_error(_update(viewer, row, 1), 403, "FORBIDDEN")
    assert_error(_update(anon, row, 1), 401, "NOT_AUTHENTICATED")
    db.expire_all()
    assert _row(db, world).quantity == 100


def test_quantity_validation(manager, world, db):
    row = _row(db, world)
    for bad in (-1, 1.5, "10", None, 1_000_000_001):
        assert_error(_update(manager, row, bad), 422, "VALIDATION_ERROR")
    db.expire_all()
    assert _row(db, world).quantity == 100


def test_reason_is_required(manager, world, db):
    row = _row(db, world)
    response = manager.patch(
        f"{API}/inventory/{row.id}", json={"quantity": 1, "expected_version": row.version}
    )
    error = assert_error(response, 422, "VALIDATION_ERROR")
    assert error["details"][0]["field"] == "body.reason"


def test_invalid_and_unknown_identifiers(manager):
    body = {"quantity": 1, "expected_version": 1, "reason": "count"}
    assert_error(manager.patch(f"{API}/inventory/abc", json=body), 422, "VALIDATION_ERROR")
    assert_error(
        manager.patch(f"{API}/inventory/00000000-0000-4000-8000-000000000000", json=body),
        404,
        "NOT_FOUND",
    )


def test_stale_version_is_rejected_and_keeps_first_write(manager, world, db):
    row = _row(db, world)
    stale_version = row.version
    assert _update(manager, row, 60, stale_version).status_code == 200
    error = assert_error(_update(manager, row, 70, stale_version), 409, "VERSION_CONFLICT")
    assert error["details"][0]["current_version"] == stale_version + 1
    db.expire_all()
    assert _row(db, world).quantity == 60


def test_concurrent_updates_with_same_version_have_one_winner(manager, world, db):
    row = _row(db, world)
    version = row.version
    with ThreadPoolExecutor(max_workers=6) as pool:
        responses = list(pool.map(lambda q: _update(manager, row, q, version), range(10, 16)))
    assert sorted(r.status_code for r in responses) == [200, 409, 409, 409, 409, 409]
    winner = next(r for r in responses if r.status_code == 200).json()
    db.expire_all()
    assert _row(db, world).quantity == winner["quantity"]
    assert _row(db, world).version == version + 1


def test_cursor_returns_every_remaining_row_once_while_the_list_changes(admin, world, db):
    # Regression: offset pages repeated or skipped rows when products changed during a full read.
    def read(after=None):
        params = {"warehouse_id": str(world.toronto.id), "sort": "id", "page_size": 1}
        if after:
            params["after_id"] = after
        response = admin.get(f"{API}/inventory", params=params)
        assert response.status_code == 200
        return response.json()["items"]

    everything = admin.get(
        f"{API}/inventory", params={"warehouse_id": str(world.toronto.id), "sort": "id"}
    ).json()["items"]
    assert len(everything) >= 2
    first = read()
    assert first[0]["id"] == everything[0]["id"]
    assert admin.delete(f"{API}/products/{first[0]['product']['id']}").status_code == 204

    seen = [first[0]["id"]]
    while page := read(seen[-1]):
        seen.append(page[0]["id"])
    assert seen == [row["id"] for row in everything]


def test_cursor_needs_id_ascending(viewer, world):
    params = {"after_id": str(world.toronto.id)}
    assert_error(viewer.get(f"{API}/inventory", params=params), 422, "VALIDATION_ERROR")
    response = viewer.get(f"{API}/inventory", params={**params, "sort": "id", "direction": "desc"})
    assert_error(response, 422, "VALIDATION_ERROR")
