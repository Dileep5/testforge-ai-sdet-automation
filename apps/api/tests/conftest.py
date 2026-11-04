"""Backend tests run against real PostgreSQL in a dedicated database, never the dev database."""

import os
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+psycopg://testforge:testforge_local@127.0.0.1:55432/testforge_test",
)
if not urlsplit(TEST_DATABASE_URL).path.endswith("_test"):
    raise RuntimeError("Tests wipe their database, so its name must end in _test")

os.environ.update(
    APP_ENV="test",
    DATABASE_URL=TEST_DATABASE_URL,
    PAYMENT_SIM_TIMEOUT_MS="20",
    COOKIE_SECURE="false",
)

import pytest  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.exc import OperationalError  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from alembic import command  # noqa: E402
from app.db import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Customer, Inventory, Product, Role, User, Warehouse  # noqa: E402
from app.security import hash_password  # noqa: E402
from app.seed import reset  # noqa: E402

API_ROOT = Path(__file__).resolve().parents[1]
API = "/api/v1"
PASSWORD = "Correct-Horse-Battery-9"
_PASSWORD_HASH = hash_password(PASSWORD)


def alembic_config() -> Config:
    config = Config(str(API_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(API_ROOT / "alembic"))
    return config


@pytest.fixture(scope="session", autouse=True)
def migrated_database() -> None:
    try:
        with engine.begin() as conn:
            conn.execute(text("DROP SCHEMA public CASCADE"))
            conn.execute(text("CREATE SCHEMA public"))
    except OperationalError as exc:
        pytest.exit(f"PostgreSQL is not reachable; run scripts/db-local.sh start. {exc}", 2)
    command.upgrade(alembic_config(), "head")


@dataclass
class World:
    """The fixed catalog each test starts from. IDs are random, so tests cannot hard-code them."""

    customer_a: Customer
    customer_b: Customer
    toronto: Warehouse
    calgary: Warehouse
    drill: Product
    gloves: Product
    retired: Product
    admin: User
    manager: User
    viewer: User
    buyer_a: User


@pytest.fixture(autouse=True)
def world() -> World:
    with SessionLocal() as db:
        reset(db)
        customer_a = Customer(code="ACME", name="Acme Test Co", contact_email="a@acme.example")
        customer_b = Customer(code="BETA", name="Beta Test Co", contact_email="b@beta.example")
        toronto = Warehouse(
            code="TOR", name="Toronto", city="Toronto", province="ON", tax_rate_bps=1300
        )
        calgary = Warehouse(
            code="CAL", name="Calgary", city="Calgary", province="AB", tax_rate_bps=500
        )
        drill = Product(sku="DRL-1", name="Drill", category="Tools", unit_price_cents=1999)
        gloves = Product(sku="GLV-1", name="Gloves", category="Safety", unit_price_cents=333)
        retired = Product(
            sku="OLD-1",
            name="Retired Thing",
            category="Tools",
            unit_price_cents=100,
            is_active=False,
        )
        db.add_all([customer_a, customer_b, toronto, calgary, drill, gloves, retired])
        db.flush()

        def user(email: str, role: Role, customer: Customer | None = None) -> User:
            return User(
                email=email,
                full_name=email.split("@")[0].title(),
                password_hash=_PASSWORD_HASH,
                role=role,
                customer_id=customer.id if customer else None,
            )

        admin = user("admin@test.example", Role.ADMIN)
        manager = user("manager@test.example", Role.MANAGER)
        viewer = user("viewer@test.example", Role.VIEWER)
        buyer_a = user("buyer@acme.example", Role.VIEWER, customer_a)
        db.add_all([admin, manager, viewer, buyer_a])
        for warehouse, drills, glove_count in ((toronto, 100, 10), (calgary, 5, 0)):
            db.add(Inventory(product_id=drill.id, warehouse_id=warehouse.id, quantity=drills))
            db.add(Inventory(product_id=gloves.id, warehouse_id=warehouse.id, quantity=glove_count))
            db.add(Inventory(product_id=retired.id, warehouse_id=warehouse.id, quantity=50))
        db.commit()
        return World(
            customer_a,
            customer_b,
            toronto,
            calgary,
            drill,
            gloves,
            retired,
            admin,
            manager,
            viewer,
            buyer_a,
        )


@pytest.fixture
def db() -> Iterator[Session]:
    with SessionLocal() as session:
        yield session


@pytest.fixture
def anon() -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client


@pytest.fixture
def login() -> Iterator[Callable[[User], TestClient]]:
    clients: list[TestClient] = []

    def _login(user: User) -> TestClient:
        client = TestClient(app, raise_server_exceptions=False)
        response = client.post(
            f"{API}/auth/login", json={"email": user.email, "password": PASSWORD}
        )
        assert response.status_code == 200, response.text
        clients.append(client)
        return client

    yield _login
    for client in clients:
        client.close()


@pytest.fixture
def admin(login, world) -> TestClient:
    return login(world.admin)


@pytest.fixture
def manager(login, world) -> TestClient:
    return login(world.manager)


@pytest.fixture
def viewer(login, world) -> TestClient:
    return login(world.viewer)


@pytest.fixture
def buyer_a(login, world) -> TestClient:
    return login(world.buyer_a)


@pytest.fixture
def create_order(manager, world) -> Callable[..., dict]:
    def _create(customer=None, warehouse=None, items=None, client=None) -> dict:
        response = (client or manager).post(
            f"{API}/orders",
            json={
                "customer_id": str((customer or world.customer_a).id),
                "warehouse_id": str((warehouse or world.toronto).id),
                "items": items or [{"product_id": str(world.drill.id), "quantity": 2}],
            },
        )
        assert response.status_code == 201, response.text
        return response.json()

    return _create


@pytest.fixture
def pay(manager) -> Callable[..., dict]:
    def _pay(order_id: str, token: str = "sim_success", key: str | None = None) -> dict:
        response = manager.post(
            f"{API}/orders/{order_id}/payments",
            json={"method_token": token},
            headers={"Idempotency-Key": key or f"test-{order_id}-{token}"},
        )
        assert response.status_code == 201, response.text
        return response.json()

    return _pay


def assert_error(response, status: int, code: str) -> dict:
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == {"error"}
    assert body["error"]["code"] == code
    assert body["error"]["message"]
    assert body["error"]["request_id"] == response.headers["x-request-id"]
    return body["error"]
