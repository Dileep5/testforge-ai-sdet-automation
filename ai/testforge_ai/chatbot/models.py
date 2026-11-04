"""Schemas for the support chatbot. Evidence and generated answers are kept in separate fields."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

MAX_QUESTION_CHARS = 1000

Status = Literal["answered", "refused", "needs_clarification"]
RefusalReason = Literal[
    "no_evidence",
    "conflicting_evidence",
    "prompt_injection",
    "data_request",
    "order_not_available",
    "output_rejected",
    "provider_error",
    "tool_error",
    "invalid_input",
]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KnowledgeDocument(Strict):
    id: Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}-\d{3}$")]
    topic: str
    title: str
    text: str
    # Named values, so two documents that disagree can be detected without reading them.
    facts: dict[str, str] = {}


class KnowledgeBase(Strict):
    version: str
    notice: str
    documents: list[KnowledgeDocument]


class Evidence(BaseModel):
    """Text a person approved, or a value read by a backend tool. Never written by the model."""

    source_id: str
    title: str
    text: str
    score: float
    kind: Literal["faq", "live_order"] = "faq"


class Citation(Strict):
    source_id: Annotated[str, StringConstraints(max_length=40)]
    quote: Annotated[str, StringConstraints(min_length=1, max_length=600)]


class TokenUsage(BaseModel):
    input_tokens: int
    output_tokens: int


class ChatResponse(BaseModel):
    status: Status
    answer: str | None = Field(None, description="Generated text. Set only when status=answered.")
    message: str | None = Field(None, description="Fixed text explaining a refusal or a question.")
    refusal_reason: RefusalReason | None = None
    citations: list[Citation] = []
    evidence: list[Evidence] = Field([], description="Retrieved text, separate from the answer.")
    guard_failures: list[str] = []
    mode: str
    model: str | None = None
    kb_version: str
    usage: TokenUsage | None = None
    latency_ms: float = 0.0


class LlmAnswer(Strict):
    """The only shape accepted from a model."""

    status: Literal["answered", "refused"]
    answer: Annotated[str, StringConstraints(max_length=2000)]
    citations: Annotated[list[Citation], Field(max_length=8)]


class OrderFact(Strict):
    """What a backend order tool may return. Free-text fields such as notes are left out."""

    order_number: Annotated[str, StringConstraints(pattern=r"^ORD-\d{1,18}$")]
    status: Literal["PENDING", "CONFIRMED", "SHIPPED", "DELIVERED", "CANCELLED"]
    updated_on: Annotated[str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}$")]
