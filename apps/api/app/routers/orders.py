from datetime import date
from math import ceil
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response, status

from app.deps import CurrentUser, DbSession, OperatorUser
from app.models import OrderStatus
from app.schemas import (
    OrderCreate,
    OrderDetailOut,
    OrderHistoryEntry,
    OrderStatusUpdate,
    OrderSummaryOut,
    Page,
)
from app.services import audit
from app.services import orders as service
from app.services.orders import OrderFilters, OrderSortField, SortDirection

router = APIRouter(prefix="/orders", tags=["orders"])


def order_filters(
    date_from: date | None = None,
    date_to: date | None = None,
    warehouse_id: UUID | None = None,
    customer_id: UUID | None = None,
    status: OrderStatus | None = None,
    q: Annotated[str | None, Query(max_length=40, description="Order number contains")] = None,
) -> OrderFilters:
    return OrderFilters(date_from, date_to, warehouse_id, customer_id, status, q)


Filters = Annotated[OrderFilters, Depends(order_filters)]


@router.get("", response_model=Page[OrderSummaryOut])
def list_orders(
    db: DbSession,
    user: CurrentUser,
    filters: Filters,
    sort: OrderSortField = "created_at",
    direction: SortDirection = "desc",
    page: Annotated[int, Query(ge=1, le=100_000)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> Page[OrderSummaryOut]:
    rows, total = service.list_orders(db, user, filters, sort, direction, page, page_size)
    return Page(
        items=[service.to_summary(order) for order in rows],
        total=total,
        page=page,
        page_size=page_size,
        pages=ceil(total / page_size),
    )


@router.get(
    "/export.csv",
    response_class=Response,
    responses={200: {"content": {"text/csv": {"schema": {"type": "string"}}}}},
)
def export_orders(
    db: DbSession,
    user: CurrentUser,
    filters: Filters,
    sort: OrderSortField = "created_at",
    direction: SortDirection = "desc",
) -> Response:
    content, count = service.export_csv(db, user, filters, sort, direction)
    audit.record(db, user.id, "order.exported", "order", "export", {"rows": count})
    db.commit()
    return Response(
        content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="orders.csv"'},
    )


@router.post("", response_model=OrderDetailOut, status_code=status.HTTP_201_CREATED)
def create_order(payload: OrderCreate, db: DbSession, user: OperatorUser) -> OrderDetailOut:
    # Stock, order and audit rows commit in one transaction or not at all.
    order = service.create_order(db, user, payload)
    db.commit()
    return service.to_detail(service.get_visible_order(db, user, order.id))


@router.get("/{order_id}", response_model=OrderDetailOut)
def get_order(order_id: UUID, db: DbSession, user: CurrentUser) -> OrderDetailOut:
    return service.to_detail(service.get_visible_order(db, user, order_id))


@router.get("/{order_id}/history", response_model=list[OrderHistoryEntry])
def get_order_history(order_id: UUID, db: DbSession, user: CurrentUser) -> list[OrderHistoryEntry]:
    service.get_visible_order(db, user, order_id)
    return [
        OrderHistoryEntry(
            action=entry.action,
            actor_name=entry.actor.full_name if entry.actor else None,
            details=entry.details,
            created_at=entry.created_at,
        )
        for entry in service.order_history(db, order_id)
    ]


@router.patch("/{order_id}/status", response_model=OrderDetailOut)
def update_order_status(
    order_id: UUID, payload: OrderStatusUpdate, db: DbSession, user: OperatorUser
) -> OrderDetailOut:
    service.change_status(db, user, order_id, payload.status, payload.note)
    db.commit()
    db.expire_all()
    return service.to_detail(service.get_visible_order(db, user, order_id))
