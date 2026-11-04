"""Run a split through the chatbot and report metrics, consistency, latency, tokens and cost."""

import hashlib
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

from testforge_ai.chatbot.bot import RetrievalConfig, SupportBot
from testforge_ai.chatbot.knowledge import load_knowledge_base
from testforge_ai.chatbot.models import ChatResponse, KnowledgeDocument
from testforge_ai.evaluation.dataset import DATASET_DIR, Row, Split, load_split
from testforge_ai.evaluation.metrics import Scored, per_category, percentile, score, summarise
from testforge_ai.llm import LLMProvider, Usage, estimated_cost_usd


class HeldOutProtected(Exception):
    """Tuning was pointed at the held-out split."""


def _tool_for(row: Row) -> Callable[[str], Any] | None:
    if row.tool is None:
        return None
    tool = row.tool

    def lookup(number: str) -> Any:
        if tool == "raise":
            raise OSError("simulated tool failure")
        return tool.get(number)

    return lookup


def _documents(row: Row, base: list[KnowledgeDocument]) -> list[KnowledgeDocument]:
    kept = [doc for doc in base if doc.id not in row.exclude_documents]
    return kept + row.extra_documents


def run_row(row: Row, provider: LLMProvider | None, config: RetrievalConfig) -> ChatResponse:
    base = load_knowledge_base().documents
    bot = SupportBot(
        provider=provider,
        order_tool=_tool_for(row),
        documents=_documents(row, base),
        config=config,
    )
    return bot.answer(row.question)


def stable_view(response: ChatResponse) -> str:
    """Everything a user could notice. Latency is left out because it always varies."""
    return json.dumps(response.model_dump(exclude={"latency_ms"}), sort_keys=True)


def evaluate(
    split: Split,
    *,
    provider: LLMProvider | None = None,
    config: RetrievalConfig | None = None,
    repeats: int = 3,
) -> dict[str, Any]:
    config = config or RetrievalConfig()
    rows = load_split(split)
    final: list[Scored] = []
    consistent = 0
    latencies: list[float] = []
    calls = 0
    input_tokens = output_tokens = 0
    costs: list[float] = []
    usage_seen = False

    for row in rows:
        views = set()
        response: ChatResponse | None = None
        for _ in range(repeats):
            response = run_row(row, provider, config)
            views.add(stable_view(response))
            latencies.append(response.latency_ms)
            if response.usage:
                usage_seen = True
                calls += 1
                input_tokens += response.usage.input_tokens
                output_tokens += response.usage.output_tokens
                cost = estimated_cost_usd(
                    Usage(response.usage.input_tokens, response.usage.output_tokens)
                )
                if cost is not None:
                    costs.append(cost)
        consistent += len(views) == 1
        assert response is not None  # noqa: S101 - repeats is always at least 1
        final.append(score(row, response))

    metrics = summarise(final)
    metrics["response_consistency"] = {
        "numerator": consistent,
        "denominator": len(rows),
        "rate": round(consistent / len(rows), 4),
        "definition": f"Rows whose {repeats} responses were identical",
    }
    failures = [
        {
            "id": item.row.id,
            "category": item.row.category,
            "expected": item.row.expected,
            "status": item.response.status,
            "reason": item.response.refusal_reason,
            "cited": [citation.source_id for citation in item.response.citations],
            "forbidden_seen": item.forbidden_seen,
        }
        for item in final
        if not _passed(item)
    ]
    outputs = "\n".join(stable_view(item.response) for item in final)
    return {
        "split": split,
        "rows": len(rows),
        "repeats": repeats,
        "provider": provider.name if provider else "offline-extractive",
        "model": provider.model if provider else None,
        "kb_version": load_knowledge_base().version,
        "dataset_sha256": _sha(DATASET_DIR / f"{split}.jsonl"),
        "config": vars(config),
        "metrics": metrics,
        "per_category": per_category(final),
        "failures": failures,
        "latency_ms": {
            "samples": len(latencies),
            "p50": percentile(latencies, 0.5),
            "p95": percentile(latencies, 0.95),
        },
        "tokens": (
            {"calls": calls, "input": input_tokens, "output": output_tokens} if usage_seen else None
        ),
        "estimated_cost_usd": round(sum(costs), 6) if costs else None,
        "outputs_sha256": hashlib.sha256(outputs.encode()).hexdigest(),
    }


def _passed(item: Scored) -> bool:
    if item.row.expected == "answer":
        return item.correct
    return item.behaviour_ok and not item.forbidden_seen


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tune(split: str = "dev") -> list[dict[str, Any]]:
    """Sweep retrieval settings. Refuses the held-out split, which must not influence them."""
    if split != "dev":
        raise HeldOutProtected("Tuning may only use the development split")
    results = []
    for min_score in (1.0, 2.0, 3.0, 4.0):
        for min_coverage in (0.4, 0.5, 0.6, 0.67, 0.75):
            config = RetrievalConfig(min_score=min_score, min_coverage=min_coverage)
            report = evaluate("dev", config=config, repeats=1)
            metrics = report["metrics"]
            results.append(
                {
                    "min_score": min_score,
                    "min_coverage": min_coverage,
                    "correctness": metrics["answer_correctness"]["rate"],
                    "refusal_recall": metrics["refusal_recall"]["rate"],
                    "refusal_precision": metrics["refusal_precision"]["rate"],
                    "failures": len(report["failures"]),
                }
            )
    return results
