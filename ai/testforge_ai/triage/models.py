"""Schemas for failure triage. Output is advice for a person and changes nothing."""

from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints


class Category(StrEnum):
    APPLICATION_REGRESSION = "application_regression"
    LOCATOR_ISSUE = "locator_issue"
    TIMING = "timing_or_synchronization"
    ENVIRONMENT = "environment_failure"
    TEST_DATA = "test_data_issue"
    UNKNOWN = "unknown"


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ApiCall(Strict):
    method: str
    url: str
    status: int | None = None
    failure: str | None = None


class TraceSummary(Strict):
    """Only actions and statuses. Cookies, headers, parameters and bodies are never read out."""

    actions_total: int = 0
    failed_actions: list[str] = []
    unfinished_actions: list[str] = []
    http_errors: list[ApiCall] = []


class FailureRecord(Strict):
    """One failed test, redacted. Titles are kept for people and are not used to classify."""

    test: str
    project: str
    status: str
    errors: list[str]
    console_errors: list[str] = []
    page_errors: list[str] = []
    failed_requests: list[ApiCall] = []
    error_responses: list[ApiCall] = []
    pending_requests: list[ApiCall] = []
    trace: TraceSummary | None = None
    page_snapshot: str | None = None
    screenshot: str | None = None
    sources: list[str] = []


class EvidenceItem(Strict):
    id: str
    source: str
    detail: str


class LlmOpinion(Strict):
    """Advice from a model, kept apart from the rule-based result. It never replaces that result."""

    status: Literal["accepted", "rejected"]
    model: str
    category: Category | None = None
    explanation: str | None = None
    evidence_ids: list[str] = []
    agrees_with_rules: bool | None = None
    rejection_reason: str | None = None
    used_screenshot: bool = False


class Triage(Strict):
    test: str
    project: str
    category: Category
    confidence: Literal["high", "medium", "low"]
    uncertainty: str
    alternatives: list[Category]
    evidence: list[EvidenceItem]
    suggested_investigation: str
    human_review_required: bool
    # Stated in the output so that no consumer can read a result as permission to act.
    automatic_changes_allowed: Literal[False] = False
    analysis: Literal["deterministic"] = "deterministic"
    llm_opinion: LlmOpinion | None = None


class LlmTriage(Strict):
    """The only shape accepted from a model."""

    category: Category
    evidence_ids: Annotated[list[str], Field(min_length=1, max_length=20)]
    explanation: Annotated[str, StringConstraints(min_length=1, max_length=1000)]
