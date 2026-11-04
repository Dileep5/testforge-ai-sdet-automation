from fastapi import APIRouter, status
from sqlalchemy import select

from app.deps import AdminUser, CurrentUser, DbSession
from app.errors import AppError
from app.models import Customer
from app.schemas import CustomerCreate, CustomerOut
from app.services import audit

router = APIRouter(prefix="/customers", tags=["customers"])


@router.get("", response_model=list[CustomerOut])
def list_customers(db: DbSession, user: CurrentUser) -> list[Customer]:
    stmt = select(Customer).order_by(Customer.name)
    if user.customer_id is not None:
        stmt = stmt.where(Customer.id == user.customer_id)
    return list(db.scalars(stmt))


@router.post("", response_model=CustomerOut, status_code=status.HTTP_201_CREATED)
def create_customer(payload: CustomerCreate, db: DbSession, admin: AdminUser) -> Customer:
    if db.scalar(select(Customer.id).where(Customer.code == payload.code)) is not None:
        raise AppError(409, "DUPLICATE_CUSTOMER", f"Customer {payload.code} already exists")
    customer = Customer(**payload.model_dump())
    db.add(customer)
    db.flush()
    audit.record(db, admin.id, "customer.created", "customer", customer.id, {"code": customer.code})
    db.commit()
    return customer
