from uuid import UUID

from fastapi import APIRouter
from sqlalchemy import select

from app.deps import CurrentUser, DbSession
from app.errors import not_found
from app.models import Warehouse
from app.schemas import WarehouseOut

router = APIRouter(prefix="/warehouses", tags=["warehouses"])


@router.get("", response_model=list[WarehouseOut])
def list_warehouses(db: DbSession, _: CurrentUser) -> list[Warehouse]:
    return list(db.scalars(select(Warehouse).order_by(Warehouse.code)))


@router.get("/{warehouse_id}", response_model=WarehouseOut)
def get_warehouse(warehouse_id: UUID, db: DbSession, _: CurrentUser) -> Warehouse:
    warehouse = db.get(Warehouse, warehouse_id)
    if warehouse is None:
        raise not_found("Warehouse")
    return warehouse
