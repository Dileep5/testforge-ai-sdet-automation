from fastapi import APIRouter
from sqlalchemy import func, select

from app.deps import CurrentUser, DbSession
from app.models import Inventory, Order, OrderStatus, Payment, PaymentStatus, Product
from app.schemas import DashboardSummary
from app.services import orders as order_service
from app.services.orders import OrderFilters

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

_OPEN = (OrderStatus.PENDING, OrderStatus.CONFIRMED, OrderStatus.SHIPPED)


@router.get("/summary", response_model=DashboardSummary)
def summary(db: DbSession, user: CurrentUser) -> DashboardSummary:
    counts = dict(
        db.execute(
            order_service.scope_to_user(
                select(Order.status, func.count()).group_by(Order.status), user
            )
        ).all()
    )
    by_status = {status: counts.get(status, 0) for status in OrderStatus}
    revenue = db.scalar(
        order_service.scope_to_user(
            select(func.coalesce(func.sum(Payment.amount_cents), 0))
            .join(Order, Payment.order_id == Order.id)
            .where(Payment.status == PaymentStatus.SETTLED),
            user,
        )
    )
    low_stock = db.scalar(
        select(func.count())
        .select_from(Inventory)
        .join(Product, Inventory.product_id == Product.id)
        .where(Product.is_active.is_(True), Inventory.quantity <= Inventory.reorder_level)
    )
    recent, _ = order_service.list_orders(db, user, OrderFilters(), "created_at", "desc", 1, 5)
    return DashboardSummary(
        total_orders=sum(by_status.values()),
        open_orders=sum(by_status[status] for status in _OPEN),
        orders_by_status=by_status,
        settled_revenue_cents=revenue or 0,
        low_stock_count=low_stock or 0,
        recent_orders=[order_service.to_summary(order) for order in recent],
    )
