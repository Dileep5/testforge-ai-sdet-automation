from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings

engine = create_engine(
    get_settings().database_url,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,
    # UTC on every connection, so API timestamps do not depend on the server's time zone.
    connect_args={"options": "-c timezone=UTC"},
)
# Responses are serialized after commit, so loaded attributes must stay readable.
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    # Routes commit explicitly; anything uncommitted is rolled back on close.
    with SessionLocal() as session:
        yield session
