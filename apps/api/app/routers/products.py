from math import ceil
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import joinedload

from app.deps import AdminUser, CurrentUser, DbSession, OperatorUser
from app.errors import AppError, not_found
from app.models import Inventory, Product, Role, Warehouse
from app.schemas import (
    Page,
    ProductCreate,
    ProductDetailOut,
    ProductOut,
    ProductStockOut,
    ProductUpdate,
    WarehouseRef,
)
from app.services import audit

router = APIRouter(prefix="/products", tags=["products"])

_SORT_COLUMNS = {
    "name": Product.name,
    "sku": Product.sku,
    "category": Product.category,
    "unit_price_cents": Product.unit_price_cents,
}

_total_quantity = (
    select(func.coalesce(func.sum(Inventory.quantity), 0))
    .where(Inventory.product_id == Product.id)
    .correlate(Product)
    .scalar_subquery()
)


def _to_out(product: Product, total_quantity: int) -> ProductOut:
    return ProductOut(
        id=product.id,
        sku=product.sku,
        name=product.name,
        description=product.description,
        category=product.category,
        unit_price_cents=product.unit_price_cents,
        is_active=product.is_active,
        total_quantity=total_quantity,
        created_at=product.created_at,
        updated_at=product.updated_at,
    )


@router.get("", response_model=Page[ProductOut])
def list_products(
    db: DbSession,
    user: CurrentUser,
    q: Annotated[str | None, Query(max_length=100, description="Name or SKU contains")] = None,
    category: Annotated[str | None, Query(max_length=80)] = None,
    in_stock: bool | None = None,
    include_inactive: bool = False,
    sort: Literal["name", "sku", "category", "unit_price_cents"] = "name",
    direction: Literal["asc", "desc"] = "asc",
    page: Annotated[int, Query(ge=1, le=100_000)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> Page[ProductOut]:
    stmt = select(Product)
    # Only staff who manage the catalog may see retired products in listings.
    if not (include_inactive and user.role in (Role.ADMIN, Role.MANAGER)):
        stmt = stmt.where(Product.is_active.is_(True))
    if q:
        stmt = stmt.where(
            Product.name.icontains(q, autoescape=True) | Product.sku.icontains(q, autoescape=True)
        )
    if category:
        stmt = stmt.where(Product.category == category)
    if in_stock is not None:
        stmt = stmt.where(_total_quantity > 0 if in_stock else _total_quantity == 0)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    column = _SORT_COLUMNS[sort]
    rows = db.execute(
        stmt.add_columns(_total_quantity)
        .order_by(column.asc() if direction == "asc" else column.desc(), Product.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return Page(
        items=[_to_out(product, quantity) for product, quantity in rows],
        total=total,
        page=page,
        page_size=page_size,
        pages=ceil(total / page_size),
    )


@router.get("/categories", response_model=list[str])
def list_categories(db: DbSession, _: CurrentUser) -> list[str]:
    stmt = (
        select(Product.category)
        .where(Product.is_active.is_(True))
        .distinct()
        .order_by(Product.category)
    )
    return list(db.scalars(stmt))


def _detail(db: DbSession, product_id: UUID) -> ProductDetailOut:
    product = db.get(Product, product_id)
    if product is None:
        raise not_found("Product")
    rows = db.scalars(
        select(Inventory)
        .join(Warehouse)
        .options(joinedload(Inventory.warehouse))
        .where(Inventory.product_id == product_id)
        .order_by(Warehouse.code)
    ).all()
    return ProductDetailOut(
        **_to_out(product, sum(row.quantity for row in rows)).model_dump(),
        stock=[
            ProductStockOut(
                inventory_id=row.id,
                warehouse=WarehouseRef.model_validate(row.warehouse),
                quantity=row.quantity,
                reorder_level=row.reorder_level,
                version=row.version,
            )
            for row in rows
        ],
    )


@router.get("/{product_id}", response_model=ProductDetailOut)
def get_product(product_id: UUID, db: DbSession, _: CurrentUser) -> ProductDetailOut:
    return _detail(db, product_id)


@router.post("", response_model=ProductDetailOut, status_code=status.HTTP_201_CREATED)
def create_product(payload: ProductCreate, db: DbSession, user: OperatorUser) -> ProductDetailOut:
    if db.scalar(select(Product.id).where(Product.sku == payload.sku)) is not None:
        raise AppError(409, "DUPLICATE_SKU", f"A product with SKU {payload.sku} already exists")
    product = Product(**payload.model_dump())
    db.add(product)
    db.flush()
    # Every product is stocked (at zero) everywhere, so inventory rows always exist to update.
    for warehouse_id in db.scalars(select(Warehouse.id)):
        db.add(Inventory(product_id=product.id, warehouse_id=warehouse_id, quantity=0))
    audit.record(db, user.id, "product.created", "product", product.id, {"sku": product.sku})
    db.commit()
    return _detail(db, product.id)


@router.patch("/{product_id}", response_model=ProductDetailOut)
def update_product(
    product_id: UUID, payload: ProductUpdate, db: DbSession, user: OperatorUser
) -> ProductDetailOut:
    product = db.get(Product, product_id, with_for_update=True)
    if product is None:
        raise not_found("Product")
    changes = payload.model_dump(exclude_unset=True, exclude_none=True)
    for field, value in changes.items():
        setattr(product, field, value)
    audit.record(db, user.id, "product.updated", "product", product.id, changes)
    db.commit()
    return _detail(db, product.id)


@router.delete("/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_product(product_id: UUID, db: DbSession, admin: AdminUser) -> None:
    # A soft delete: past orders still reference the product.
    product = db.get(Product, product_id, with_for_update=True)
    if product is None:
        raise not_found("Product")
    product.is_active = False
    audit.record(db, admin.id, "product.deactivated", "product", product.id, {"sku": product.sku})
    db.commit()
