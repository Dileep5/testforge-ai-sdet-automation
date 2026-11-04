import json
import logging
from pathlib import Path

import pytest
from pydantic import BaseModel

from testforge_ai.chatbot.bot import SupportBot
from testforge_ai.chatbot.models import LlmAnswer
from testforge_ai.generation.models import LlmBatch
from testforge_ai.generation.pipeline import generate, load_story
from testforge_ai.llm import (
    ALLOW_LIVE_ENV,
    LiveModeNotAllowed,
    LLMError,
    OpenAIProvider,
    Usage,
    estimated_cost_usd,
    strict_schema,
)

FAKE_KEY = "sk-testonlyfakekey1234567890"
AI_DIR = Path(__file__).resolve().parents[1]


class TestOptIn:
    def test_a_key_alone_does_not_enable_live_calls(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("OPENAI_API_KEY", FAKE_KEY)
        monkeypatch.setenv("OPENAI_MODEL", "fake-model")
        with pytest.raises(LiveModeNotAllowed, match=ALLOW_LIVE_ENV):
            OpenAIProvider.from_env()

    def test_the_flag_alone_does_not_enable_live_calls(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(ALLOW_LIVE_ENV, "1")
        with pytest.raises(LiveModeNotAllowed, match="OPENAI_API_KEY"):
            OpenAIProvider.from_env()

    def test_a_model_must_be_named(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(ALLOW_LIVE_ENV, "1")
        monkeypatch.setenv("OPENAI_API_KEY", FAKE_KEY)
        with pytest.raises(LiveModeNotAllowed, match="model"):
            OpenAIProvider.from_env()

    def test_the_default_bot_is_offline_even_with_a_key_set(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("OPENAI_API_KEY", FAKE_KEY)
        assert SupportBot().answer("How long do refunds take?").mode == "offline-extractive"


def live_provider(monkeypatch: pytest.MonkeyPatch, base_url: str) -> OpenAIProvider:
    monkeypatch.setenv(ALLOW_LIVE_ENV, "1")
    monkeypatch.setenv("OPENAI_API_KEY", FAKE_KEY)
    monkeypatch.setenv("OPENAI_MODEL", "fake-model")
    monkeypatch.setenv("OPENAI_BASE_URL", base_url)
    return OpenAIProvider.from_env()


class TestProviderOverHttp:
    """The real SDK against a local fake server. This is not a test of a real model."""

    def test_request_shape_and_usage(self, fake_openai, monkeypatch: pytest.MonkeyPatch) -> None:
        provider = live_provider(monkeypatch, fake_openai.base_url)
        fake_openai.reply_text = json.dumps({"ok": True})
        result = provider.complete_json(
            instructions="Rules",
            data={"question": "Hello?"},
            schema_name="thing",
            schema={"type": "object"},
        )
        assert result.text == '{"ok": true}'
        assert result.model == "fake-model"
        assert result.usage == Usage(120, 30)
        sent = fake_openai.requests[0]
        assert sent["path"] == "/v1/responses"
        assert sent["auth"] == f"Bearer {FAKE_KEY}"
        assert sent["body"]["store"] is False
        assert sent["body"]["instructions"] == "Rules"
        assert sent["body"]["text"]["format"]["strict"] is True
        content = sent["body"]["input"][0]["content"][0]["text"]
        assert json.loads(content) == {"untrusted_data": {"question": "Hello?"}}

    def test_images_are_sent_only_when_passed(
        self, fake_openai, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        provider = live_provider(monkeypatch, fake_openai.base_url)
        image = tmp_path / "shot.png"
        image.write_bytes(b"\x89PNG fake")
        provider.complete_json(
            instructions="R", data={}, schema_name="t", schema={"type": "object"}, images=[image]
        )
        content = fake_openai.requests[0]["body"]["input"][0]["content"]
        assert content[1]["type"] == "input_image"
        assert content[1]["image_url"].startswith("data:image/png;base64,")

    def test_full_chat_through_the_sdk(self, fake_openai, monkeypatch: pytest.MonkeyPatch) -> None:
        provider = live_provider(monkeypatch, fake_openai.base_url)
        quote = "Items can be returned within 30 days of delivery."
        fake_openai.reply_text = json.dumps(
            {
                "status": "answered",
                "answer": quote,
                "citations": [{"source_id": "RET-001", "quote": quote}],
            }
        )
        response = SupportBot(provider=provider).answer("How many days do I have to return?")
        assert response.status == "answered"
        assert response.mode == "openai"
        assert response.model == "fake-model"
        assert response.usage is not None
        assert response.usage.input_tokens == 120

    def test_full_generation_through_the_sdk(
        self, fake_openai, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        provider = live_provider(monkeypatch, fake_openai.base_url)
        fake_openai.reply_text = (AI_DIR / "fixtures" / "generation" / "good.json").read_text()
        bundle = generate(load_story(AI_DIR / "stories" / "US-102.json"), provider=provider)
        assert bundle.generator == "openai"
        assert bundle.model == "fake-model"
        assert len(bundle.cases) == 5
        assert fake_openai.requests[0]["body"]["text"]["format"]["name"] == "test_cases"


class TestCredentials:
    def test_key_is_not_in_repr(self, fake_openai, monkeypatch: pytest.MonkeyPatch) -> None:
        provider = live_provider(monkeypatch, fake_openai.base_url)
        assert FAKE_KEY not in repr(provider)
        assert FAKE_KEY not in str(provider)

    def test_errors_and_logs_leak_neither_key_nor_detail(
        self, fake_openai, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        provider = live_provider(monkeypatch, fake_openai.base_url)
        fake_openai.status = 401
        with caplog.at_level(logging.DEBUG), pytest.raises(LLMError) as caught:
            provider.complete_json(
                instructions="R",
                data={"question": "SECRET-QUESTION"},
                schema_name="t",
                schema={"type": "object"},
            )
        assert FAKE_KEY not in str(caught.value)
        assert "secret detail" not in str(caught.value)
        assert caught.value.__cause__ is None
        assert FAKE_KEY not in caplog.text

    def test_chat_turns_a_provider_failure_into_a_refusal(
        self, fake_openai, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        provider = live_provider(monkeypatch, fake_openai.base_url)
        fake_openai.status = 500
        response = SupportBot(provider=provider).answer("How long do refunds take?")
        assert response.status == "refused"
        assert response.refusal_reason == "provider_error"
        assert FAKE_KEY not in response.model_dump_json()


class TestStrictSchema:
    @pytest.mark.parametrize("model", [LlmAnswer, LlmBatch])
    def test_every_object_is_closed_and_fully_required(self, model: type[BaseModel]) -> None:
        def check(node: object) -> None:
            if isinstance(node, dict):
                if "properties" in node:
                    assert node["additionalProperties"] is False
                    assert sorted(node["required"]) == sorted(node["properties"])
                for value in node.values():
                    check(value)
            elif isinstance(node, list):
                for value in node:
                    check(value)

        check(strict_schema(model))

    def test_a_field_named_title_survives(self) -> None:
        schema = strict_schema(LlmBatch)
        assert "title" in schema["$defs"]["GeneratedCase"]["properties"]


class TestCost:
    def test_no_price_means_no_estimate(self) -> None:
        assert estimated_cost_usd(Usage(1000, 1000)) is None

    def test_cost_uses_supplied_prices(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("TESTFORGE_INPUT_USD_PER_MTOK", "2")
        monkeypatch.setenv("TESTFORGE_OUTPUT_USD_PER_MTOK", "10")
        assert estimated_cost_usd(Usage(1_000_000, 500_000)) == pytest.approx(7.0)
