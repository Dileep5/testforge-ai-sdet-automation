import csv
import io
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Literal
from uuid import UUID

from sqlalchemy import Select, String, cast, func, select
from sqlalchemy.orm import Session, joinedload, selectinload

from app.errors import AppError, not_found
from app.models import (
    AuditLog,
    Customer,
    Inventory,
    Order,
    OrderItem,
    OrderStatus,
    Payment,
    PaymentStatus,
    Product,
    User,
    Warehouse,
    order_number_seq,
    utc_now,
)
from app.money import format_decimal, line_total_cents, tax_cents
from app.schemas import OrderCreate, OrderDetailOut, OrderSummaryOut
from app.services import audit

TRANSITIONS: dict[OrderStatus, list[OrderStatus]] = {
    OrderStatus.PENDING: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
    OrderStatus.CONFIRMED: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
    OrderStatus.SHIPPED: [OrderStatus.DELIVERED],
    OrderStatus.DELIVERED: [],
    OrderStatus.CANCELLED: [],
}

OrderSortField = Literal["created_at", "order_number", "status", "total_cents"]
SortDirection = Literal["asc", "desc"]

_SORT_COLUMNS = {
    "created_at": Order.created_at,
    "order_number": Order.order_number,
    "status": Order.status,
    "total_cents": Order.total_cents,
}


@dataclass(frozen=True)
class OrderFilters:
    date_from: date | None = None
    date_to: date | None = None
    warehouse_id: UUID | None = None
    customer_id: UUID | None = None
    status: OrderStatus | None = None
    q: str | None = None


def _with_relations(stmt: Select) -> Select:
    return stmt.options(
        joinedload(Order.customer),
        joinedload(Order.warehouse),
        joinedload(Order.created_by),
        selectinload(Order.items),
        selectinload(Order.payments),
    )


def scope_to_user(stmt: Select, user: User) -> Select:
    """Restrict a query on Order to what the user may see."""
    if user.customer_id is not None:
        return stmt.where(Order.customer_id == user.customer_id)
    return stmt


def apply_filters(stmt: Select, filters: OrderFilters) -> Select:
    if filters.date_from and filters.date_to and filters.date_from > filters.date_to:
        raise AppError(
            422,
            "VALIDATION_ERROR",
            "date_from must not be after date_to",
            [{"field": "query.date_from", "message": "must not be after date_to"}],
        )
    # Date filters are whole UTC days and date_to is inclusive.
    if filters.date_from:
        stmt = stmt.where(Order.created_at >= datetime.combine(filters.date_from, time.min, UTC))
    if filters.date_to:
        next_day = filters.date_to + timedelta(days=1)
        stmt = stmt.where(Order.created_at < datetime.combine(next_day, time.min, UTC))
    if filters.warehouse_id:
        stmt = stmt.where(Order.warehouse_id == filters.warehouse_id)
    if filters.customer_id:
        stmt = stmt.where(Order.customer_id == filters.customer_id)
    if filters.status:
        stmt = stmt.where(Order.status == filters.status)
    if filters.q:
        stmt = stmt.where(Order.order_number.icontains(filters.q, autoescape=True))
    return stmt


def _ordered(stmt: Select, sort: OrderSortField, direction: SortDirection) -> Select:
    column = _SORT_COLUMNS[sort]
    # The id tie-breaker keeps pagination stable when sort values repeat.
    return stmt.order_by(column.asc() if direction == "asc" else column.desc(), Order.id)


def list_orders(
    db: Session,
    user: User,
    filters: OrderFilters,
    sort: OrderSortField,
    direction: SortDirection,
    page: int,
    page_size: int,
) -> tuple[list[Order], int]:
    base = apply_filters(scope_to_user(select(Order), user), filters)
    total = db.scalar(select(func.count()).select_from(base.subquery())) or 0
    stmt = _with_relations(_ordered(base, sort, direction))
    rows = db.scalars(stmt.offset((page - 1) * page_size).limit(page_size)).unique().all()
    return list(rows), total


def get_visible_order(db: Session, user: User, order_id: UUID) -> Order:
    # Another customer's order is reported as 404 so that its existence is not revealed.
    stmt = _with_relations(scope_to_user(select(Order).where(Order.id == order_id), user))
    order = db.scalars(stmt).unique().one_or_none()
    if order is None:
        raise not_found("Order")
    return order


def latest_payment_status(order: Order) -> PaymentStatus | None:
    return order.payments[-1].status if order.payments else None


def to_summary(order: Order) -> OrderSummaryOut:
    return OrderSummaryOut(
        id=order.id,
        order_number=order.order_number,
        customer=order.customer,
        warehouse=order.warehouse,
        status=order.status,
        payment_status=latest_payment_status(order),
        item_count=len(order.items),
        subtotal_cents=order.subtotal_cents,
        tax_cents=order.tax_cents,
        total_cents=order.total_cents,
        created_at=order.created_at,
        updated_at=order.updated_at,
    )


def to_detail(order: Order) -> OrderDetailOut:
    return OrderDetailOut(
        **to_summary(order).model_dump(),
        tax_rate_bps=order.tax_rate_bps,
        notes=order.notes,
        created_by_name=order.created_by.full_name,
        items=order.items,
        payments=order.payments,
        allowed_transitions=TRANSITIONS[order.status],
    )


def _lock_inventory(
    db: Session, warehouse_id: UUID, product_ids: list[UUID]
) -> dict[UUID, Inventory]:
    # Locking in a consistent order prevents deadlocks between overlapping orders.
    rows = db.scalars(
        select(Inventory)
        .where(Inventory.warehouse_id == warehouse_id, Inventory.product_id.in_(product_ids))
        .order_by(Inventory.product_id)
        .with_for_update()
    ).all()
    return {row.product_id: row for row in rows}


def create_order(db: Session, user: User, payload: OrderCreate) -> Order:
    if db.get(Customer, payload.customer_id) is None:
        raise AppError(422, "INVALID_REFERENCE", "Customer does not exist")
    warehouse = db.get(Warehouse, payload.warehouse_id)
    if warehouse is None:
        raise AppError(422, "INVALID_REFERENCE", "Warehouse does not exist")

    product_ids = [item.product_id for item in payload.items]
    products = {
        product.id: product
        for product in db.scalars(select(Product).where(Product.id.in_(product_ids)))
    }
    invalid = [
        {
            "field": "items",
            "product_id": str(pid),
            "message": "product does not exist or is inactive",
        }
        for pid in product_ids
        if pid not in products or not products[pid].is_active
    ]
    if invalid:
        raise AppError(422, "INVALID_REFERENCE", "One or more products cannot be ordered", invalid)

    stock = _lock_inventory(db, warehouse.id, product_ids)
    shortages = []
    for item in payload.items:
        available = stock[item.product_id].quantity if item.product_id in stock else 0
        if item.quantity > available:
            shortages.append(
                {
                    "product_id": str(item.product_id),
                    "sku": products[item.product_id].sku,
                    "requested": item.quantity,
                    "available": available,
                }
            )
    if shortages:
        raise AppError(
            409, "INSUFFICIENT_STOCK", f"Not enough stock at {warehouse.code}", shortages
        )

    lines = []
    for item in payload.items:
        product = products[item.product_id]
        lines.append(
            OrderItem(
                product_id=product.id,
                sku=product.sku,
                product_name=product.name,
                quantity=item.quantity,
                unit_price_cents=product.unit_price_cents,
                line_total_cents=line_total_cents(item.quantity, product.unit_price_cents),
            )
        )
        stock[item.product_id].quantity -= item.quantity
        stock[item.product_id].version += 1

    subtotal = sum(line.line_total_cents for line in lines)
    tax = tax_cents(subtotal, warehouse.tax_rate_bps)
    order = Order(
        order_number=f"ORD-{db.scalar(order_number_seq.next_value())}",
        customer_id=payload.customer_id,
        warehouse_id=warehouse.id,
        status=OrderStatus.PENDING,
        subtotal_cents=subtotal,
        tax_rate_bps=warehouse.tax_rate_bps,
        tax_cents=tax,
        total_cents=subtotal + tax,
        notes=payload.notes,
        created_by_id=user.id,
        items=lines,
    )
    db.add(order)
    db.flush()
    audit.record(
        db,
        user.id,
        "order.created",
        "order",
        order.id,
        {"order_number": order.order_number, "total_cents": order.total_cents, "lines": len(lines)},
    )
    return order


def change_status(
    db: Session, user: User, order_id: UUID, new_status: OrderStatus, note: str
) -> None:
    order = db.scalar(
        scope_to_user(select(Order).where(Order.id == order_id), user).with_for_update()
    )
    if order is None:
        raise not_found("Order")
    allowed = TRANSITIONS[order.status]
    if new_status not in allowed:
        raise AppError(
            409,
            "INVALID_TRANSITION",
            f"An order in status {order.status.value} cannot move to {new_status.value}",
            [
                {
                    "from": order.status.value,
                    "to": new_status.value,
                    "allowed": [s.value for s in allowed],
                }
            ],
        )

    payments = db.scalars(select(Payment).where(Payment.order_id == order.id)).all()
    live = next(
        (p for p in payments if p.status in (PaymentStatus.AUTHORIZED, PaymentStatus.SETTLED)),
        None,
    )
    if new_status is OrderStatus.CONFIRMED and live is None:
        raise AppError(409, "PAYMENT_REQUIRED", "An authorized payment is required to confirm")
    if new_status is OrderStatus.SHIPPED and (
        live is None or live.status is not PaymentStatus.SETTLED
    ):
        raise AppError(409, "PAYMENT_NOT_SETTLED", "Payment must be settled before shipping")
    if new_status is OrderStatus.CANCELLED:
        _cancel(db, user, order, live)

    previous = order.status
    order.status = new_status
    audit.record(
        db,
        user.id,
        "order.status_changed",
        "order",
        order.id,
        {"from": previous.value, "to": new_status.value, "note": note},
    )


def _cancel(db: Session, user: User, order: Order, live: Payment | None) -> None:
    if live is not None and live.status is PaymentStatus.SETTLED:
        raise AppError(
            409, "REFUND_NOT_SUPPORTED", "A settled order cannot be cancelled in this system"
        )
    if live is not None:
        live.status = PaymentStatus.VOIDED
        live.voided_at = utc_now()
        audit.record(db, user.id, "payment.voided", "payment", live.id, {"order_id": str(order.id)})
    # Cancelling releases the stock the order was holding.
    items = db.scalars(select(OrderItem).where(OrderItem.order_id == order.id)).all()
    stock = _lock_inventory(db, order.warehouse_id, [item.product_id for item in items])
    for item in items:
        stock[item.product_id].quantity += item.quantity
        stock[item.product_id].version += 1


def order_history(db: Session, order_id: UUID) -> list[AuditLog]:
    payment_ids = select(cast(Payment.id, String)).where(Payment.order_id == order_id)
    stmt = (
        select(AuditLog)
        .options(joinedload(AuditLog.actor))
        .where(
            ((AuditLog.entity_type == "order") & (AuditLog.entity_id == str(order_id)))
            | ((AuditLog.entity_type == "payment") & AuditLog.entity_id.in_(payment_ids))
        )
        .order_by(AuditLog.created_at, AuditLog.id)
    )
    return list(db.scalars(stmt))


CSV_COLUMNS = [
    "order_number",
    "created_at",
    "customer_code",
    "customer_name",
    "warehouse_code",
    "status",
    "payment_status",
    "line_count",
    "subtotal_cents",
    "tax_cents",
    "total_cents",
    "total",
]


def _csv_safe(value: str) -> str:
    # Stops spreadsheet apps from evaluating user-supplied text as a formula.
    return f"'{value}" if value[:1] in ("=", "+", "-", "@", "\t", "\r") else value


def export_csv(
    db: Session, user: User, filters: OrderFilters, sort: OrderSortField, direction: SortDirection
) -> tuple[str, int]:
    stmt = _with_relations(
        _ordered(apply_filters(scope_to_user(select(Order), user), filters), sort, direction)
    )
    orders = db.scalars(stmt).unique().all()
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    for order in orders:
        payment = latest_payment_status(order)
        writer.writerow(
            [
                order.order_number,
                order.created_at.astimezone(UTC).isoformat(),
                _csv_safe(order.customer.code),
                _csv_safe(order.customer.name),
                order.warehouse.code,
                order.status.value,
                payment.value if payment else "",
                len(order.items),
                order.subtotal_cents,
                order.tax_cents,
                order.total_cents,
                format_decimal(order.total_cents),
            ]
        )
    return buffer.getvalue(), len(orders)
