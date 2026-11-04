from typing import Any


class AppError(Exception):
    """A business or request error rendered with the standard error envelope."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        details: list[dict[str, Any]] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details or []


def not_found(resource: str) -> AppError:
    return AppError(404, "NOT_FOUND", f"{resource} not found")
