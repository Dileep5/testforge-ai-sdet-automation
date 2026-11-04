"""Deterministic synthetic seed data. Every name, email and company here is fictional.

Run with `python -m app.seed --reset`. Identifiers derive from uuid5 and all randomness comes from
a fixed seed, so two runs produce identical business data apart from password salts.
"""

import argparse
import random
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import SessionLocal
from app.models import (
    AuditLog,
    Base,
    Customer,
    Inventory,
    Order,
    OrderItem,
    OrderStatus,
    Payment,
    PaymentStatus,
    Product,
    Role,
    User,
    Warehouse,
)
from app.money import line_total_cents, tax_cents
from app.security import hash_password
from app.services.payments import _fingerprint

NAMESPACE = uuid.UUID("7c1e6a52-3f0b-4d57-9a44-0d6f1f0a2b11")
ANCHOR = datetime(2026, 1, 5, 14, 0, tzinfo=UTC)
ORDER_COUNT = 60

# Local development credentials for fictional accounts. Seeding is refused in production.
USERS = [
    ("admin@testforge.example", "Avery Admin", "Admin!Forge2026", Role.ADMIN, None),
    ("manager@testforge.example", "Morgan Manager", "Manager!Forge2026", Role.MANAGER, None),
    ("viewer@testforge.example", "Riley Viewer", "Viewer!Forge2026", Role.VIEWER, None),
    ("buyer@mapleridge.example", "Casey Buyer", "Buyer!Forge2026", Role.VIEWER, "MAPLE"),
    ("buyer@granite.example", "Jordan Buyer", "Buyer!Forge2026", Role.VIEWER, "GRANITE"),
]

CUSTOMERS = [
    ("MAPLE", "Maple Ridge Supply Co.", "orders@mapleridge.example"),
    ("GRANITE", "Granite Harbour Foods", "purchasing@granite.example"),
    ("AURORA", "Aurora Trades Ltd.", "ops@aurora-trades.example"),
    ("PRAIRIE", "Prairie Bolt Distributors", "buying@prairiebolt.example"),
    ("LAKESHORE", "Lakeshore Clinic Supplies", "supply@lakeshore-clinic.example"),
]

WAREHOUSES = [
    ("YYZ1", "Toronto Fulfilment Centre", "Toronto", "ON", 1300),
    ("YVR1", "Vancouver Distribution Hub", "Vancouver", "BC", 1200),
    ("YUL1", "Montreal Logistics Park", "Montreal", "QC", 1498),
    ("YYC1", "Calgary Regional Depot", "Calgary", "AB", 500),
]

PRODUCTS = [
    ("FAS-1001", "Hex Bolt M8 x 40 (Box of 100)", "Fasteners", 1849),
    ("FAS-1002", "Hex Nut M8 (Box of 200)", "Fasteners", 1299),
    ("FAS-1003", "Flat Washer M8 (Box of 500)", "Fasteners", 1575),
    ("FAS-1004", "Wood Screw #10 x 2in (Box of 250)", "Fasteners", 2199),
    ("TOL-2001", "Cordless Drill 18V", "Tools", 14999),
    ("TOL-2002", "Impact Driver 18V", "Tools", 16950),
    ("TOL-2003", "Digital Torque Wrench", "Tools", 23475),
    ("TOL-2004", "Laser Distance Meter", "Tools", 8925),
    ("SAF-3001", "Nitrile Gloves L (Case of 1000)", "Safety", 7450),
    ("SAF-3002", "Safety Glasses Clear (Pack of 12)", "Safety", 3360),
    ("SAF-3003", "Hi-Vis Vest Class 2", "Safety", 1895),
    ("SAF-3004", "Hard Hat Type 2", "Safety", 4275),
    ("PKG-4001", "Corrugated Box 18x12x12 (Bundle of 25)", "Packaging", 3199),
    ("PKG-4002", "Stretch Wrap 18in Roll", "Packaging", 2449),
    ("PKG-4003", "Packing Tape 2in (Case of 36)", "Packaging", 6120),
    ("PKG-4004", "Pallet Label 4x6 (Roll of 500)", "Packaging", 2875),
    ("ELE-5001", "LED High Bay Fixture 150W", "Electrical", 18999),
    ("ELE-5002", "THHN Wire 12 AWG 500ft", "Electrical", 12850),
    ("ELE-5003", "GFCI Outlet 20A", "Electrical", 2795),
    ("ELE-5004", "Cable Tie 11in (Bag of 1000)", "Electrical", 2133),
    ("JAN-6001", "Floor Degreaser 20L", "Janitorial", 8999),
    ("JAN-6002", "Paper Towel Roll (Case of 12)", "Janitorial", 4150),
    ("JAN-6003", "Heavy Duty Trash Bags (Case of 100)", "Janitorial", 3625),
    ("JAN-6004", "Spill Absorbent 15kg", "Janitorial", 2988),
]

# Fixed stock cases that the UI and tests can rely on.
OUT_OF_STOCK_SKU = "SAF-3004"
LOW_STOCK_SKU = "ELE-5003"
RETIRED_SKU = "JAN-6004"


def seed_uuid(kind: str, key: object) -> uuid.UUID:
    return uuid.uuid5(NAMESPACE, f"{kind}:{key}")


def reset(db: Session) -> None:
    db.expunge_all()
    tables = ", ".join(f'"{table.name}"' for table in Base.metadata.sorted_tables)
    db.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))  # noqa: S608
    db.execute(text("ALTER SEQUENCE order_number_seq RESTART"))


def seed(db: Session) -> dict[str, int]:
    customers = {
        code: Customer(
            id=seed_uuid("customer", code),
            code=code,
            name=name,
            contact_email=email,
            created_at=ANCHOR,
        )
        for code, name, email in CUSTOMERS
    }
    db.add_all(customers.values())
    db.flush()

    users = {}
    for email, name, password, role, customer in USERS:
        users[email] = User(
            id=seed_uuid("user", email),
            email=email,
            full_name=name,
            password_hash=hash_password(password),
            role=role,
            customer_id=customers[customer].id if customer else None,
            created_at=ANCHOR,
            updated_at=ANCHOR,
        )
    db.add_all(users.values())

    warehouses = [
        Warehouse(
            id=seed_uuid("warehouse", code),
            code=code,
            name=name,
            city=city,
            province=province,
            tax_rate_bps=bps,
        )
        for code, name, city, province, bps in WAREHOUSES
    ]
    db.add_all(warehouses)

    products = [
        Product(
            id=seed_uuid("product", sku),
            sku=sku,
            name=name,
            description=f"{name}. Synthetic catalog item for demonstration only.",
            category=category,
            unit_price_cents=price,
            is_active=sku != RETIRED_SKU,
            created_at=ANCHOR,
            updated_at=ANCHOR,
        )
        for sku, name, category, price in PRODUCTS
    ]
    db.add_all(products)
    db.flush()

    rng = random.Random(20260105)
    for product in products:
        for warehouse in warehouses:
            if product.sku == OUT_OF_STOCK_SKU:
                quantity = 0
            elif product.sku == LOW_STOCK_SKU:
                quantity = 4
            else:
                quantity = rng.randint(150, 900)
            db.add(
                Inventory(
                    id=seed_uuid("inventory", f"{product.sku}:{warehouse.code}"),
                    product_id=product.id,
                    warehouse_id=warehouse.id,
                    quantity=quantity,
                    reorder_level=10,
                    updated_at=ANCHOR,
                )
            )
    db.flush()

    orderable = [
        p for p in products if p.is_active and p.sku not in (OUT_OF_STOCK_SKU, LOW_STOCK_SKU)
    ]
    manager = users["manager@testforge.example"]
    customer_list = list(customers.values())
    statuses = list(OrderStatus)
    for index in range(ORDER_COUNT):
        _seed_order(
            db,
            index,
            created_at=ANCHOR + timedelta(days=index * 3, hours=rng.randint(0, 8)),
            customer=customer_list[index % len(customer_list)],
            warehouse=warehouses[index % len(warehouses)],
            status=statuses[rng.randrange(len(statuses))],
            picks=rng.sample(orderable, rng.randint(1, 5)),
            quantities=[rng.randint(1, 12) for _ in range(5)],
            manager=manager,
        )
    db.flush()
    return {
        "customers": len(customers),
        "users": len(users),
        "warehouses": len(warehouses),
        "products": len(products),
        "orders": ORDER_COUNT,
    }


def _seed_order(
    db: Session,
    index: int,
    created_at: datetime,
    customer: Customer,
    warehouse: Warehouse,
    status: OrderStatus,
    picks: list[Product],
    quantities: list[int],
    manager: User,
) -> None:
    order_id = seed_uuid("order", index)
    lines = [
        OrderItem(
            id=seed_uuid("order_item", f"{index}:{product.sku}"),
            product_id=product.id,
            sku=product.sku,
            product_name=product.name,
            quantity=quantity,
            unit_price_cents=product.unit_price_cents,
            line_total_cents=line_total_cents(quantity, product.unit_price_cents),
        )
        for product, quantity in zip(picks, quantities, strict=False)
    ]
    subtotal = sum(line.line_total_cents for line in lines)
    tax = tax_cents(subtotal, warehouse.tax_rate_bps)
    number = db.scalar(text("SELECT nextval('order_number_seq')"))
    order = Order(
        id=order_id,
        order_number=f"ORD-{number}",
        customer_id=customer.id,
        warehouse_id=warehouse.id,
        status=status,
        subtotal_cents=subtotal,
        tax_rate_bps=warehouse.tax_rate_bps,
        tax_cents=tax,
        total_cents=subtotal + tax,
        notes="",
        created_by_id=manager.id,
        created_at=created_at,
        updated_at=created_at,
        items=lines,
    )
    db.add(order)
    db.flush()
    db.add(
        AuditLog(
            id=seed_uuid("audit", index),
            actor_user_id=manager.id,
            action="order.created",
            entity_type="order",
            entity_id=str(order_id),
            details={
                "order_number": order.order_number,
                "total_cents": order.total_cents,
                "seed": True,
            },
            created_at=created_at,
        )
    )

    # Payment state is derived from the order status so that seeded data obeys the business rules.
    payment_status = {
        OrderStatus.CONFIRMED: PaymentStatus.AUTHORIZED,
        OrderStatus.SHIPPED: PaymentStatus.SETTLED,
        OrderStatus.DELIVERED: PaymentStatus.SETTLED,
    }.get(status)
    if payment_status is None:
        return
    settled = payment_status is PaymentStatus.SETTLED
    paid_at = created_at + timedelta(hours=1)
    db.add(
        Payment(
            id=seed_uuid("payment", index),
            order_id=order_id,
            idempotency_key=f"seed-payment-{index:04d}",
            request_fingerprint=_fingerprint(order_id, "sim_success"),
            method_token="sim_success",
            amount_cents=order.total_cents,
            status=payment_status,
            created_by_id=manager.id,
            created_at=paid_at,
            updated_at=paid_at,
            authorized_at=paid_at,
            settled_at=paid_at + timedelta(hours=1) if settled else None,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Load deterministic synthetic data")
    parser.add_argument("--reset", action="store_true", help="Delete all existing data first")
    args = parser.parse_args()
    if get_settings().app_env == "production":
        raise SystemExit("Refusing to seed: APP_ENV is production")
    with SessionLocal() as db:
        if args.reset:
            reset(db)
        elif db.scalar(text("SELECT count(*) FROM users")):
            raise SystemExit("Database already has data. Use --reset to replace it.")
        counts = seed(db)
        db.commit()
    print("Seeded:", ", ".join(f"{count} {name}" for name, count in counts.items()))


if __name__ == "__main__":
    main()
