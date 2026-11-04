import logging

from fastapi import APIRouter, Response, status
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.db import SessionLocal
from app.schemas import HealthOut, ReadinessOut

router = APIRouter(tags=["health"])
logger = logging.getLogger(__name__)


@router.get("/health", response_model=HealthOut)
def health() -> HealthOut:
    """Liveness: the process is up. Deliberately does not touch the database."""
    return HealthOut(status="ok")


@router.get(
    "/ready",
    response_model=ReadinessOut,
    responses={503: {"model": ReadinessOut, "description": "A dependency is unavailable"}},
)
def ready(response: Response) -> ReadinessOut:
    """Readiness: the database is reachable and migrations have been applied."""
    try:
        with SessionLocal() as db:
            migration = db.scalar(text("SELECT version_num FROM alembic_version"))
    except SQLAlchemyError:
        logger.exception("Readiness check failed")
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return ReadinessOut(status="not_ready", database="unavailable", migration=None)
    if migration is None:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return ReadinessOut(status="not_ready", database="ok", migration=None)
    return ReadinessOut(status="ready", database="ok", migration=migration)
