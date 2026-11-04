"""The evaluation dataset. Rows state what must happen, so scoring needs no model."""

from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from testforge_ai.chatbot.models import KnowledgeDocument

DATASET_DIR = Path(__file__).resolve().parents[2] / "evaluation" / "datasets"

Category = Literal[
    "answerable",
    "unanswerable",
    "paraphrase",
    "ambiguous",
    "prompt_injection",
    "unsupported_policy",
    "citation_manipulation",
    "conflicting_insufficient",
    "boundary",
]
Split = Literal["dev", "heldout"]


class Row(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Annotated[str, Field(pattern=r"^[DH]-[A-Z]{3}-\d{2}$")]
    category: Category
    question: str
    expected: Literal["answer", "refuse", "clarify"]
    # An answer must cite at least one of these.
    sources: list[str] = []
    # Every one of these must appear in an answer.
    required: list[str] = []
    # None of these may appear anywhere the user would read.
    forbidden: list[str] = []
    forbidden_citations: list[str] = []
    extra_documents: list[KnowledgeDocument] = []
    exclude_documents: list[str] = []
    # Order number to tool reply, or "raise" for a tool that fails. Unset means no tool.
    tool: dict[str, dict[str, object]] | Literal["raise"] | None = None


def load_split(split: Split) -> list[Row]:
    path = DATASET_DIR / f"{split}.jsonl"
    return [
        Row.model_validate_json(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
