"""Schemas for requirements, generated test cases and their review."""

import hashlib
import json
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from testforge_ai.safety import normalize_untrusted

MAX_STORY_FILE_BYTES = 64 * 1024

ShortText = Annotated[str, StringConstraints(min_length=1, max_length=300)]
LongText = Annotated[str, StringConstraints(min_length=1, max_length=1000)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class AcceptanceCriterion(Strict):
    id: Annotated[str, StringConstraints(pattern=r"^AC-\d{1,3}$")]
    text: LongText

    @field_validator("text", mode="before")
    @classmethod
    def _clean(cls, value: object) -> object:
        return normalize_untrusted(value) if isinstance(value, str) else value


class UserStory(Strict):
    """A requirement. Its text is untrusted: it is data for the generator, never an instruction."""

    id: Annotated[str, StringConstraints(pattern=r"^US-\d{1,5}$")]
    title: ShortText
    as_a: ShortText
    i_want: LongText
    so_that: LongText
    surface: Literal["ui", "api", "both"]
    allowed_roles: Annotated[list[ShortText], Field(min_length=1, max_length=10)]
    forbidden_roles: Annotated[list[ShortText], Field(max_length=10)] = []
    acceptance_criteria: Annotated[list[AcceptanceCriterion], Field(min_length=1, max_length=30)]

    @field_validator("title", "as_a", "i_want", "so_that", mode="before")
    @classmethod
    def _clean(cls, value: object) -> object:
        return normalize_untrusted(value) if isinstance(value, str) else value

    @model_validator(mode="after")
    def _unique_criteria(self) -> "UserStory":
        ids = [item.id for item in self.acceptance_criteria]
        if len(ids) != len(set(ids)):
            raise ValueError("acceptance criterion ids must be unique")
        return self

    def requirement_ids(self) -> set[str]:
        return {f"{self.id}/{item.id}" for item in self.acceptance_criteria}

    def digest(self) -> str:
        return sha256_json(self.model_dump())


class Category(StrEnum):
    POSITIVE = "positive"
    NEGATIVE = "negative"
    BOUNDARY = "boundary"
    AUTHORIZATION = "authorization"
    ACCESSIBILITY = "accessibility"


class GeneratedCase(Strict):
    """One candidate test exactly as a generator produced it."""

    title: ShortText
    category: Category
    priority: Literal["P1", "P2", "P3"]
    requirement_ids: Annotated[list[str], Field(min_length=1, max_length=30)]
    preconditions: Annotated[list[LongText], Field(max_length=20)]
    steps: Annotated[list[LongText], Field(min_length=1, max_length=30)]
    expected_results: Annotated[list[LongText], Field(min_length=1, max_length=20)]
    assumptions: Annotated[list[LongText], Field(max_length=20)]


class GeneratedBatch(Strict):
    """The JSON a generator must return. Cases are validated one by one by the pipeline."""

    story_id: str
    cases: list[object]


class LlmBatch(Strict):
    """The schema sent to a live model. Pydantic still validates each case afterwards."""

    story_id: str
    cases: list[GeneratedCase]


class ReviewStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class Decision(Strict):
    reviewer: ShortText
    note: Annotated[str, StringConstraints(max_length=1000)]
    decided_at: str
    case_sha256: str
    story_sha256: str


class Flag(Strict):
    kind: Literal[
        "declared_assumption",
        "unsupported_number",
        "unsupported_role",
        "unsupported_quote",
        "near_duplicate",
        "story_flagged",
    ]
    detail: str


class ReviewCase(Strict):
    id: str
    case: GeneratedCase
    flags: list[Flag]
    status: ReviewStatus = ReviewStatus.PENDING
    decision: Decision | None = None

    def digest(self) -> str:
        return sha256_json(self.case.model_dump(mode="json"))


class RejectedCase(Strict):
    index: int
    reasons: list[str]


class Coverage(Strict):
    uncovered_requirements: list[str]
    missing_categories: list[str]


class ReviewBundle(Strict):
    """The only thing the exporter reads, so nothing reaches it without passing the pipeline."""

    schema_version: Literal[1] = 1
    story: UserStory
    story_flags: list[str]
    generator: str
    model: str
    cases: list[ReviewCase]
    rejected: list[RejectedCase]
    coverage: Coverage


def sha256_json(value: object) -> str:
    encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()
