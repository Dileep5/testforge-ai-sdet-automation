"""The one place that talks to a model. Everything else depends on the small Protocol below."""

import json
import os
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from pydantic import BaseModel

ALLOW_LIVE_ENV = "TESTFORGE_ALLOW_LIVE_LLM"
MAX_OUTPUT_TOKENS = 2_000
TIMEOUT_SECONDS = 30.0


class LLMError(Exception):
    """A provider failed. The message never contains credentials or request content."""


class LiveModeNotAllowed(LLMError):
    """Live mode was requested without every explicit opt-in."""


@dataclass(frozen=True)
class Usage:
    input_tokens: int
    output_tokens: int


@dataclass(frozen=True)
class LLMResult:
    text: str
    model: str
    usage: Usage | None = None
    latency_ms: float = 0.0


class LLMProvider(Protocol):
    name: str
    model: str

    def complete_json(
        self,
        *,
        instructions: str,
        data: dict[str, Any],
        schema_name: str,
        schema: dict[str, Any],
        images: Sequence[Path] = (),
    ) -> LLMResult: ...


def strict_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Convert a Pydantic model to the strict subset used for structured output.

    Length and pattern limits are dropped from what is sent, and Pydantic still enforces them on
    what comes back. The response is never trusted just because a schema was requested.
    """
    dropped = {"title", "default", "minLength", "maxLength", "minItems", "maxItems", "pattern"}

    def convert(node: Any) -> Any:
        if isinstance(node, list):
            return [convert(item) for item in node]
        if not isinstance(node, dict):
            return node
        result = {key: convert(value) for key, value in node.items() if key not in dropped}
        if "properties" in node:
            # The names under "properties" are field names, so "title" must survive there.
            result["properties"] = {
                name: convert(value) for name, value in node["properties"].items()
            }
            result["required"] = sorted(node["properties"])
            result["additionalProperties"] = False
        return result

    return convert(model.model_json_schema())


class ScriptedProvider:
    """Returns prepared text. Used for fixtures and for tests that assume a hostile model."""

    name = "scripted"

    def __init__(
        self,
        reply: str | Callable[[dict[str, Any]], str],
        model: str = "scripted",
        usage: Usage | None = None,
    ) -> None:
        self.reply = reply
        self.model = model
        self.usage = usage
        self.calls: list[dict[str, Any]] = []

    def complete_json(
        self,
        *,
        instructions: str,
        data: dict[str, Any],
        schema_name: str,
        schema: dict[str, Any],
        images: Sequence[Path] = (),
    ) -> LLMResult:
        self.calls.append(
            {
                "instructions": instructions,
                "data": data,
                "schema_name": schema_name,
                "schema": schema,
                "images": list(images),
            }
        )
        text = self.reply(data) if callable(self.reply) else self.reply
        return LLMResult(text=text, model=self.model, usage=self.usage)


class OpenAIProvider:
    """OpenAI Responses API. Created only through from_env, and only with an explicit opt-in."""

    name = "openai"

    def __init__(self, api_key: str, model: str, base_url: str | None = None) -> None:
        # Imported here so that offline use needs no SDK and cannot reach the network by accident.
        from openai import OpenAI

        self.model = model
        self._client = OpenAI(
            api_key=api_key, base_url=base_url, timeout=TIMEOUT_SECONDS, max_retries=1
        )

    def __repr__(self) -> str:
        return f"OpenAIProvider(model={self.model!r})"

    @classmethod
    def from_env(cls, model: str | None = None) -> "OpenAIProvider":
        """A key in the environment is not consent: the allow flag must be set as well."""
        if os.environ.get(ALLOW_LIVE_ENV) != "1":
            raise LiveModeNotAllowed(f"Live LLM calls are off. Set {ALLOW_LIVE_ENV}=1 to opt in.")
        key = os.environ.get("OPENAI_API_KEY")
        if not key:
            raise LiveModeNotAllowed("OPENAI_API_KEY is not set.")
        chosen = model or os.environ.get("OPENAI_MODEL")
        if not chosen:
            raise LiveModeNotAllowed("Name a model with --model or OPENAI_MODEL.")
        return cls(api_key=key, model=chosen, base_url=os.environ.get("OPENAI_BASE_URL"))

    def complete_json(
        self,
        *,
        instructions: str,
        data: dict[str, Any],
        schema_name: str,
        schema: dict[str, Any],
        images: Sequence[Path] = (),
    ) -> LLMResult:
        from openai import OpenAIError

        content: list[dict[str, Any]] = [
            {"type": "input_text", "text": json.dumps({"untrusted_data": data}, ensure_ascii=False)}
        ]
        content.extend({"type": "input_image", "image_url": _data_url(path)} for path in images)
        started = time.perf_counter()
        try:
            response = self._client.responses.create(
                model=self.model,
                instructions=instructions,
                input=[{"role": "user", "content": content}],
                text={
                    "format": {
                        "type": "json_schema",
                        "name": schema_name,
                        "schema": schema,
                        "strict": True,
                    }
                },
                max_output_tokens=MAX_OUTPUT_TOKENS,
                store=False,
            )
        except OpenAIError as exc:
            # The type alone: an SDK message could quote the request.
            raise LLMError(f"OpenAI request failed: {type(exc).__name__}") from None
        usage = response.usage
        return LLMResult(
            text=response.output_text,
            model=response.model,
            usage=Usage(usage.input_tokens, usage.output_tokens) if usage else None,
            latency_ms=(time.perf_counter() - started) * 1000,
        )


def _data_url(path: Path) -> str:
    import base64

    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def estimated_cost_usd(usage: Usage | None) -> float | None:
    """Prices change, so they are supplied by whoever runs this and never built in."""
    input_price = os.environ.get("TESTFORGE_INPUT_USD_PER_MTOK")
    output_price = os.environ.get("TESTFORGE_OUTPUT_USD_PER_MTOK")
    if usage is None or input_price is None or output_price is None:
        return None
    return (
        usage.input_tokens * float(input_price) + usage.output_tokens * float(output_price)
    ) / 1_000_000
