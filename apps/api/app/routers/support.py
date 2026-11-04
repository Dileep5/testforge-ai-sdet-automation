from functools import lru_cache

from fastapi import APIRouter
from sqlalchemy import select
from testforge_ai.chatbot.bot import SupportBot, find_order_number
from testforge_ai.chatbot.models import ChatResponse, OrderFact
from testforge_ai.llm import OpenAIProvider

from app.config import get_settings
from app.deps import CurrentUser, DbSession
from app.models import Order
from app.schemas import SupportChatRequest
from app.services import orders as order_service

router = APIRouter(prefix="/support", tags=["support"])


@lru_cache
def get_bot() -> SupportBot:
    live = get_settings().support_chat_provider == "openai"
    return SupportBot(provider=OpenAIProvider.from_env() if live else None)


def _order_fact(db: DbSession, user: CurrentUser, number: str) -> OrderFact | None:
    # The same scope as every other order read: authorization is decided here, not by a prompt.
    order = db.scalar(
        order_service.scope_to_user(select(Order).where(Order.order_number == number), user)
    )
    if order is None:
        return None
    return OrderFact(
        order_number=order.order_number,
        status=order.status.value,
        updated_on=order.updated_at.date().isoformat(),
    )


@router.post("/chat", response_model=ChatResponse)
def chat(payload: SupportChatRequest, db: DbSession, user: CurrentUser) -> ChatResponse:
    """Answer from approved support articles, and from orders the signed-in user may see."""
    number = find_order_number(payload.question)
    fact = _order_fact(db, user, number) if number else None
    # A model call can take seconds, and must not hold a database connection for that long.
    db.rollback()
    return get_bot().answer(payload.question, order_tool=lambda _: fact)
