from math import ceil
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Query
from sqlalchemy import func, select
from sqlalchemy.orm import joinedload

from app.deps import CurrentUser, DbSession, OperatorUser
from app.errors import AppError, not_found
from app.models import Inventory, Product, Warehouse
from app.schemas import InventoryOut, InventoryUpdate, Page
from app.services import audit

router = APIRouter(prefix="/inventory", tags=["inventory"])

_SORT_COLUMNS = {
    "sku": Product.sku,
    "name": Product.name,
    "quantity": Inventory.quantity,
    "id": Inventory.id,
}


def _load(db: DbSession, inventory_id: UUID) -> Inventory:
    row = db.scalar(
        select(Inventory)
        .options(joinedload(Inventory.product), joinedload(Inventory.warehouse))
        .where(Inventory.id == inventory_id)
    )
    if row is None:
        raise not_found("Inventory record")
    return row


@router.get("", response_model=Page[InventoryOut])
def list_inventory(
    db: DbSession,
    _: CurrentUser,
    q: Annotated[str | None, Query(max_length=100, description="Name or SKU contains")] = None,
    warehouse_id: UUID | None = None,
    product_id: UUID | None = None,
    low_stock: bool = False,
    sort: Literal["sku", "name", "quantity", "id"] = "sku",
    direction: Literal["asc", "desc"] = "asc",
    after_id: Annotated[
        UUID | None,
        Query(
            description="Return rows after this id. Needs sort=id, direction=asc. Use this to read "
            "a whole list safely while it changes: offset pages can repeat or skip rows."
        ),
    ] = None,
    page: Annotated[int, Query(ge=1, le=100_000)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> Page[InventoryOut]:
    stmt = (
        select(Inventory)
        .join(Product, Inventory.product_id == Product.id)
        .join(Warehouse, Inventory.warehouse_id == Warehouse.id)
        .where(Product.is_active.is_(True))
    )
    if q:
        stmt = stmt.where(
            Product.name.icontains(q, autoescape=True) | Product.sku.icontains(q, autoescape=True)
        )
    if warehouse_id:
        stmt = stmt.where(Inventory.warehouse_id == warehouse_id)
    if product_id:
        stmt = stmt.where(Inventory.product_id == product_id)
    if low_stock:
        stmt = stmt.where(Inventory.quantity <= Inventory.reorder_level)
    if after_id:
        if sort != "id" or direction != "asc":
            raise AppError(
                422,
                "VALIDATION_ERROR",
                "after_id needs sort=id and direction=asc",
                [{"field": "query.after_id", "message": "needs sort=id and direction=asc"}],
            )
        stmt = stmt.where(Inventory.id > after_id)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    column = _SORT_COLUMNS[sort]
    rows = db.scalars(
        stmt.options(joinedload(Inventory.product), joinedload(Inventory.warehouse))
        .order_by(
            column.asc() if direction == "asc" else column.desc(), Warehouse.code, Inventory.id
        )
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return Page(
        items=rows, total=total, page=page, page_size=page_size, pages=ceil(total / page_size)
    )


@router.get("/{inventory_id}", response_model=InventoryOut)
def get_inventory(inventory_id: UUID, db: DbSession, _: CurrentUser) -> Inventory:
    return _load(db, inventory_id)


@router.patch("/{inventory_id}", response_model=InventoryOut)
def update_inventory(
    inventory_id: UUID, payload: InventoryUpdate, db: DbSession, user: OperatorUser
) -> Inventory:
    row = db.scalar(select(Inventory).where(Inventory.id == inventory_id).with_for_update())
    if row is None:
        raise not_found("Inventory record")
    if row.version != payload.expected_version:
        # Two people editing the same row: the later save must not silently overwrite the first.
        raise AppError(
            409,
            "VERSION_CONFLICT",
            "This inventory record was changed by someone else. Reload and try again.",
            [{"expected_version": payload.expected_version, "current_version": row.version}],
        )
    previous = row.quantity
    row.quantity = payload.quantity
    row.version += 1
    audit.record(
        db,
        user.id,
        "inventory.updated",
        "inventory",
        row.id,
        {"from": previous, "to": payload.quantity, "reason": payload.reason},
    )
    db.commit()
    return _load(db, inventory_id)
