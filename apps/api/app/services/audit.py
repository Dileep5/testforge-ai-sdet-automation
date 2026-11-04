from typing import Any
from uuid import UUID

from sqlalchemy.orm import Session

from app.models import AuditLog


def record(
    db: Session,
    actor_id: UUID | None,
    action: str,
    entity_type: str,
    entity_id: object,
    details: dict[str, Any] | None = None,
) -> None:
    """Add an audit row to the caller's transaction, so it commits or rolls back with the change."""
    db.add(
        AuditLog(
            actor_user_id=actor_id,
            action=action,
            entity_type=entity_type,
            entity_id=str(entity_id),
            details=details or {},
        )
    )
