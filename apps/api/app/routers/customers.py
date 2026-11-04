from fastapi import APIRouter
from sqlalchemy import select

from app.deps import CurrentUser, DbSession
from app.models import Customer
from app.schemas import CustomerOut

router = APIRouter(prefix="/customers", tags=["customers"])


@router.get("", response_model=list[CustomerOut])
def list_customers(db: DbSession, user: CurrentUser) -> list[Customer]:
    stmt = select(Customer).order_by(Customer.name)
    if user.customer_id is not None:
        stmt = stmt.where(Customer.id == user.customer_id)
    return list(db.scalars(stmt))
