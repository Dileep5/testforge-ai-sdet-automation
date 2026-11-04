from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    StringConstraints,
    field_validator,
)
from testforge_ai.chatbot.models import MAX_QUESTION_CHARS

from app.models import OrderStatus, PaymentStatus, Role

MAX_CENTS = 100_000_000_00
MAX_QUANTITY = 1_000_000_000

ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class InputModel(BaseModel):
    # Unknown fields are rejected so clients cannot smuggle in e.g. "role" or "total_cents".
    model_config = ConfigDict(extra="forbid")


class ErrorBody(BaseModel):
    code: str
    message: str
    details: list[dict[str, Any]] = []
    request_id: str | None = None


class ErrorResponse(BaseModel):
    error: ErrorBody


class Page[T](BaseModel):
    items: list[T]
    total: int
    page: int
    page_size: int
    pages: int


# --- Auth and users ---------------------------------------------------------


class LoginRequest(InputModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class CustomerRef(ORMModel):
    id: UUID
    code: str
    name: str


class CustomerOut(CustomerRef):
    contact_email: str


class CustomerCreate(InputModel):
    code: Annotated[str, StringConstraints(pattern=r"^[A-Z0-9-]{2,32}$")]
    name: ShortText
    contact_email: EmailStr


class UserOut(ORMModel):
    id: UUID
    email: str
    full_name: str
    role: Role
    is_active: bool
    customer: CustomerRef | None
    created_at: datetime


class SessionUserOut(UserOut):
    permissions: list[str]
    session_expires_at: datetime


class UserCreate(InputModel):
    email: EmailStr
    full_name: ShortText
    password: str = Field(min_length=12, max_length=256)
    role: Role
    customer_id: UUID | None = None


class UserUpdate(InputModel):
    full_name: ShortText | None = None
    role: Role | None = None
    is_active: bool | None = None


class RoleOut(BaseModel):
    name: Role
    permissions: list[str]


# --- Catalog and inventory --------------------------------------------------


class WarehouseOut(ORMModel):
    id: UUID
    code: str
    name: str
    city: str
    province: str
    tax_rate_bps: int


class WarehouseRef(ORMModel):
    id: UUID
    code: str
    name: str


class ProductOut(ORMModel):
    id: UUID
    sku: str
    name: str
    description: str
    category: str
    unit_price_cents: int
    is_active: bool
    total_quantity: int
    created_at: datetime
    updated_at: datetime


class ProductStockOut(BaseModel):
    inventory_id: UUID
    warehouse: WarehouseRef
    quantity: int
    reorder_level: int
    version: int


class ProductDetailOut(ProductOut):
    stock: list[ProductStockOut]


class ProductCreate(InputModel):
    sku: Annotated[str, StringConstraints(pattern=r"^[A-Z0-9-]{3,32}$")]
    name: ShortText
    description: Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)] = ""
    category: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
    unit_price_cents: int = Field(ge=0, le=MAX_CENTS, strict=True)


class ProductUpdate(InputModel):
    name: ShortText | None = None
    description: (
        Annotated[str, StringConstraints(strip_whitespace=True, max_length=2000)] | None
    ) = None
    category: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)] | None
    ) = None
    unit_price_cents: int | None = Field(default=None, ge=0, le=MAX_CENTS, strict=True)
    is_active: bool | None = None


class ProductRef(ORMModel):
    id: UUID
    sku: str
    name: str
    category: str
    unit_price_cents: int
    is_active: bool


class InventoryOut(ORMModel):
    id: UUID
    product: ProductRef
    warehouse: WarehouseRef
    quantity: int
    reorder_level: int
    version: int
    updated_at: datetime


class InventoryUpdate(InputModel):
    quantity: int = Field(ge=0, le=MAX_QUANTITY, strict=True)
    expected_version: int = Field(ge=1, strict=True)
    reason: Annotated[str, StringConstraints(strip_whitespace=True, min_length=3, max_length=200)]


# --- Orders -----------------------------------------------------------------


class OrderItemCreate(InputModel):
    product_id: UUID
    quantity: int = Field(gt=0, le=100_000, strict=True)


class OrderCreate(InputModel):
    customer_id: UUID
    warehouse_id: UUID
    items: list[OrderItemCreate] = Field(min_length=1, max_length=50)
    notes: Annotated[str, StringConstraints(strip_whitespace=True, max_length=1000)] = ""

    @field_validator("items")
    @classmethod
    def _unique_products(cls, items: list[OrderItemCreate]) -> list[OrderItemCreate]:
        product_ids = [item.product_id for item in items]
        if len(set(product_ids)) != len(product_ids):
            raise ValueError("each product may appear on only one line")
        return items


class OrderItemOut(ORMModel):
    id: UUID
    product_id: UUID
    sku: str
    product_name: str
    quantity: int
    unit_price_cents: int
    line_total_cents: int


class OrderSummaryOut(BaseModel):
    id: UUID
    order_number: str
    customer: CustomerRef
    warehouse: WarehouseRef
    status: OrderStatus
    payment_status: PaymentStatus | None
    item_count: int
    subtotal_cents: int
    tax_cents: int
    total_cents: int
    created_at: datetime
    updated_at: datetime


class PaymentOut(ORMModel):
    id: UUID
    order_id: UUID
    # idempotency_key is left out on purpose: it is the creating user's secret-like retry token,
    # and customer-scoped buyers can read their orders' payments.
    method_token: str
    amount_cents: int
    status: PaymentStatus
    failure_reason: str | None
    created_at: datetime
    authorized_at: datetime | None
    settled_at: datetime | None
    voided_at: datetime | None


class OrderDetailOut(OrderSummaryOut):
    tax_rate_bps: int
    notes: str
    created_by_name: str
    items: list[OrderItemOut]
    payments: list[PaymentOut]
    allowed_transitions: list[OrderStatus]


class OrderStatusUpdate(InputModel):
    status: OrderStatus
    note: Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)] = ""


class PaymentCreate(InputModel):
    # Selects the deterministic simulated outcome. No card data is ever accepted.
    method_token: Literal["sim_success", "sim_declined", "sim_timeout"]


# --- Audit, dashboard, health -----------------------------------------------


class AuditLogOut(BaseModel):
    id: UUID
    actor_email: str | None
    action: str
    entity_type: str
    entity_id: str
    details: dict[str, Any]
    created_at: datetime


class OrderHistoryEntry(BaseModel):
    action: str
    actor_name: str | None
    details: dict[str, Any]
    created_at: datetime


class DashboardSummary(BaseModel):
    total_orders: int
    open_orders: int
    orders_by_status: dict[OrderStatus, int]
    settled_revenue_cents: int
    low_stock_count: int
    recent_orders: list[OrderSummaryOut]


class HealthOut(BaseModel):
    status: Literal["ok"]


class ReadinessOut(BaseModel):
    status: Literal["ready", "not_ready"]
    database: Literal["ok", "unavailable"]
    migration: str | None


# --- Support chat -----------------------------------------------------------


class SupportChatRequest(InputModel):
    question: str = Field(min_length=1, max_length=MAX_QUESTION_CHARS)
