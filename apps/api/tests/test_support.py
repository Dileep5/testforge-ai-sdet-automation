import json

import pytest
from fastapi.testclient import TestClient
from testforge_ai.chatbot.bot import SupportBot
from testforge_ai.llm import LiveModeNotAllowed, ScriptedProvider

from app.config import get_settings
from app.db import engine
from app.routers import support


def _ask(client: TestClient, question: str) -> dict:
    response = client.post("/api/v1/support/chat", json={"question": question})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def other_customer_order(create_order, world) -> str:
    return create_order(customer=world.customer_b)["order_number"]


def test_answers_with_a_citation(viewer: TestClient) -> None:
    body = _ask(viewer, "How long do refunds take?")
    assert body["status"] == "answered"
    assert body["mode"] == "offline-extractive"
    assert body["citations"][0]["source_id"] == "REF-001"


def test_requires_a_session(anon: TestClient) -> None:
    response = anon.post("/api/v1/support/chat", json={"question": "Hello?"})
    assert response.status_code == 401


def test_order_scope_comes_from_the_backend(buyer_a, other_customer_order) -> None:
    number = other_customer_order
    denied = _ask(buyer_a, f"What is the status of {number}?")
    missing = _ask(buyer_a, "What is the status of ORD-999999999?")
    assert denied["refusal_reason"] == "order_not_available"
    for field in ("status", "answer", "message", "citations", "evidence"):
        assert denied[field] == missing[field]


def test_staff_can_read_any_order_status(viewer, other_customer_order) -> None:
    body = _ask(viewer, f"Where is {other_customer_order}?")
    assert body["status"] == "answered"
    assert body["evidence"][0]["kind"] == "live_order"


def test_no_database_connection_is_held_during_a_model_call(
    viewer, other_customer_order, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A slow model must not use up the pool: this is the Phase 2 deadlock in a new place."""
    held: list[int] = []

    def reply(data: dict) -> str:
        held.append(engine.pool.checkedout())
        return json.dumps({"status": "refused", "answer": "", "citations": []})

    bot = SupportBot(provider=ScriptedProvider(reply))
    monkeypatch.setattr(support, "get_bot", lambda: bot)
    _ask(viewer, f"Where is {other_customer_order}?")
    assert held == [0]


def test_live_provider_without_opt_in_stops_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPPORT_CHAT_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-fakefakefakefake")
    monkeypatch.delenv("TESTFORGE_ALLOW_LIVE_LLM", raising=False)
    get_settings.cache_clear()
    support.get_bot.cache_clear()
    try:
        with pytest.raises(LiveModeNotAllowed):
            support.get_bot()
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()
        support.get_bot.cache_clear()


def test_settings_do_not_hold_the_key() -> None:
    assert "openai_api_key" not in get_settings().model_dump()
