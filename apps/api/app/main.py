import logging
import uuid
from collections.abc import Awaitable, Callable
from http import HTTPStatus
from typing import Any

from fastapi import APIRouter, FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DataError, IntegrityError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import get_settings
from app.db import MAX_CONNECTIONS
from app.errors import AppError
from app.middleware import ConcurrencyLimitMiddleware
from app.routers import (
    audit,
    auth,
    customers,
    dashboard,
    health,
    inventory,
    orders,
    payments,
    products,
    users,
    warehouses,
)
from app.schemas import ErrorResponse

logger = logging.getLogger(__name__)

API_PREFIX = "/api/v1"
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

_error_responses: dict[int | str, dict[str, Any]] = {
    status: {"model": ErrorResponse} for status in (400, 401, 403, 404, 409, 422, 503)
}


def _error(
    request: Request,
    status_code: int,
    code: str,
    message: str,
    details: list[dict[str, Any]] | None = None,
) -> JSONResponse:
    request_id = getattr(request.state, "request_id", None)
    return JSONResponse(
        status_code=status_code,
        # Set here as well: the handler for unexpected errors runs outside the middleware.
        headers={"X-Request-ID": request_id} if request_id else None,
        content={
            "error": {
                "code": code,
                "message": message,
                "details": details or [],
                "request_id": request_id,
            }
        },
    )


def _validation_details(exc: RequestValidationError) -> list[dict[str, Any]]:
    # "input" is left out on purpose: it would echo submitted values such as passwords.
    return [
        {
            "field": ".".join(str(part) for part in err["loc"]),
            "message": err["msg"],
            "type": err["type"],
        }
        for err in exc.errors()
    ]


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="TestForge Commerce API",
        version="1.0.0",
        description="Synthetic B2B commerce and order management API. All data is fictional.",
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url=f"{API_PREFIX}/docs",
        redoc_url=None,
    )

    @app.middleware("http")
    async def request_context(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request.state.request_id = str(uuid.uuid4())
        # SameSite=Lax is the first CSRF defence; this rejects cross-site writes outright.
        origin = request.headers.get("origin")
        if (
            request.method in UNSAFE_METHODS
            and origin is not None
            and origin not in settings.allowed_origins
        ):
            response: Response = _error(request, 403, "ORIGIN_NOT_ALLOWED", "Origin not allowed")
        else:
            response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(AppError)
    async def handle_app_error(request: Request, exc: AppError) -> JSONResponse:
        return _error(request, exc.status_code, exc.code, exc.message, exc.details)

    @app.exception_handler(RequestValidationError)
    async def handle_validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        details = _validation_details(exc)
        if any(item["type"] == "json_invalid" for item in details):
            return _error(
                request, 400, "INVALID_JSON", "The request body is not valid JSON", details
            )
        return _error(request, 422, "VALIDATION_ERROR", "The request is not valid", details)

    @app.exception_handler(StarletteHTTPException)
    async def handle_http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = HTTPStatus(exc.status_code).name
        message = "The requested resource was not found" if exc.status_code == 404 else exc.detail
        return _error(request, exc.status_code, code, str(message))

    @app.exception_handler(IntegrityError)
    async def handle_integrity(request: Request, exc: IntegrityError) -> JSONResponse:
        # Raised by database constraints when a race slips past the service checks.
        logger.warning("Integrity error: %s", exc.orig)
        return _error(request, 409, "CONFLICT", "The request conflicts with existing data")

    @app.exception_handler(DataError)
    async def handle_data(request: Request, exc: DataError) -> JSONResponse:
        logger.warning("Data error: %s", exc.orig)
        return _error(
            request, 422, "INVALID_DATA", "The request contains values that are not valid"
        )

    @app.exception_handler(Exception)
    async def handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        # Details go to the log only: nothing internal may reach the client.
        logger.exception("Unhandled error", exc_info=exc)
        return _error(request, 500, "INTERNAL_ERROR", "An unexpected error occurred")

    # Liveness must answer while the server is busy; it does not touch the database.
    app.add_middleware(
        ConcurrencyLimitMiddleware,
        limit=MAX_CONNECTIONS,
        max_queued=settings.max_queued_requests,
        exempt_paths=frozenset({f"{API_PREFIX}/health"}),
    )

    api = APIRouter(prefix=API_PREFIX)
    api.include_router(health.router)
    for module in (
        auth,
        users,
        customers,
        warehouses,
        products,
        inventory,
        orders,
        payments,
        audit,
        dashboard,
    ):
        api.include_router(module.router, responses=_error_responses)
    app.include_router(api)
    return app


app = create_app()
