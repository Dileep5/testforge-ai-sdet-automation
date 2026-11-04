"""Score the classifier against a labelled corpus of real, deliberately caused failures."""

import json
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from testforge_ai.evaluation.metrics import wilson_interval
from testforge_ai.triage.models import Category, Triage

LABELS_PATH = Path(__file__).resolve().parents[2] / "triage-corpus" / "labels.json"
_CASE = re.compile(r"case ([A-Z]\d{2})")


def load_labels() -> dict[str, dict[str, str]]:
    return json.loads(LABELS_PATH.read_text(encoding="utf-8"))


def score_corpus(results: Iterable[Triage], split: str) -> dict[str, Any]:
    labels = load_labels()
    categories = [item.value for item in Category]
    confusion = {actual: dict.fromkeys(categories, 0) for actual in categories}
    misses = []
    total = correct = 0
    cases: set[str] = set()
    for result in results:
        match = _CASE.search(result.test)
        label = labels.get(match.group(1)) if match else None
        if label is None or label["split"] != split:
            continue
        total += 1
        cases.add(match.group(1))
        actual = label["category"]
        confusion[actual][result.category.value] += 1
        if result.category.value == actual:
            correct += 1
        else:
            misses.append(
                {
                    "case": match.group(1),
                    "project": result.project,
                    "expected": actual,
                    "got": result.category.value,
                    "confidence": result.confidence,
                    "mechanism": label["mechanism"],
                }
            )
    per_category = {}
    for category in categories:
        true_positive = confusion[category][category]
        predicted = sum(confusion[row][category] for row in categories)
        actual_count = sum(confusion[category].values())
        per_category[category] = {
            "precision": f"{true_positive}/{predicted}",
            "recall": f"{true_positive}/{actual_count}",
        }
    return {
        "split": split,
        "failures_scored": total,
        "distinct_cases": len(cases),
        "correct": correct,
        "accuracy": round(correct / total, 4) if total else None,
        "ci95": wilson_interval(correct, total),
        "per_category": per_category,
        "confusion": confusion,
        "misses": misses,
    }
