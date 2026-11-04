import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from testforge_ai.chatbot.models import ChatResponse, Citation, Evidence
from testforge_ai.evaluation.dataset import DATASET_DIR, Row, load_split
from testforge_ai.evaluation.metrics import score, summarise, wilson_interval
from testforge_ai.evaluation.runner import HeldOutProtected, evaluate, tune
from testforge_ai.llm import ScriptedProvider

EVIDENCE = [
    Evidence(source_id="RET-001", title="t", text="Items can be returned within 30 days.", score=1)
]
QUOTE = "Items can be returned within 30 days."


def row(**fields) -> Row:
    base = {"id": "D-ANS-01", "category": "answerable", "question": "q", "expected": "answer"}
    return Row.model_validate(base | fields)


def answered(answer: str = QUOTE, source: str = "RET-001", quote: str = QUOTE) -> ChatResponse:
    return ChatResponse(
        status="answered",
        answer=answer,
        citations=[Citation(source_id=source, quote=quote)],
        evidence=EVIDENCE,
        mode="test",
        kb_version="v",
    )


def refused() -> ChatResponse:
    return ChatResponse(
        status="refused", refusal_reason="no_evidence", message="No.", mode="test", kb_version="v"
    )


class TestDataset:
    @pytest.mark.parametrize("split", ["dev", "heldout"])
    def test_every_category_is_present_in_both_splits(self, split: str) -> None:
        rows = load_split(split)
        assert {item.category for item in rows} == {
            "answerable",
            "unanswerable",
            "paraphrase",
            "ambiguous",
            "prompt_injection",
            "unsupported_policy",
            "citation_manipulation",
            "conflicting_insufficient",
            "boundary",
        }
        assert len({item.id for item in rows}) == len(rows)

    def test_splits_share_no_question_asked_of_the_same_documents(self) -> None:
        def plain(split: str) -> set[str]:
            return {
                item.question
                for item in load_split(split)
                if not item.extra_documents and not item.exclude_documents
            }

        assert not plain("dev") & plain("heldout")

    def test_ids_match_their_split(self) -> None:
        assert all(item.id.startswith("D-") for item in load_split("dev"))
        assert all(item.id.startswith("H-") for item in load_split("heldout"))

    def test_expected_sources_exist(self) -> None:
        from testforge_ai.chatbot.knowledge import load_knowledge_base

        known = {doc.id for doc in load_knowledge_base().documents}
        for split in ("dev", "heldout"):
            for item in load_split(split):
                for source in item.sources:
                    assert source in known or source.startswith("LIVE-"), item.id

    def test_required_facts_are_really_in_the_expected_source(self) -> None:
        from testforge_ai.chatbot.knowledge import load_knowledge_base

        documents = {doc.id: doc for doc in load_knowledge_base().documents}
        for split in ("dev", "heldout"):
            for item in load_split(split):
                texts = [documents[s].text for s in item.sources if s in documents]
                if texts:
                    assert any(all(fact in text for fact in item.required) for text in texts), (
                        item.id
                    )


class TestHeldOutProtection:
    def test_tuning_refuses_the_held_out_split(self) -> None:
        with pytest.raises(HeldOutProtected):
            tune("heldout")

    def test_no_tuning_code_mentions_the_held_out_file(self) -> None:
        source = (Path(__file__).parents[1] / "testforge_ai" / "chatbot").rglob("*.py")
        for path in source:
            assert "heldout" not in path.read_text(), path


class TestScoring:
    def test_correct_answer(self) -> None:
        item = score(row(sources=["RET-001"], required=["30 days"]), answered())
        assert item.correct
        assert item.grounded is True
        assert (item.citations_valid, item.citations_total) == (1, 1)

    def test_missing_fact_is_not_correct(self) -> None:
        assert not score(row(required=["60 days"]), answered()).correct

    def test_wrong_source_is_not_correct(self) -> None:
        assert not score(row(sources=["SHP-001"], required=["30 days"]), answered()).correct

    def test_forbidden_citation_is_not_correct(self) -> None:
        item = score(row(forbidden_citations=["RET-001"]), answered())
        assert not item.correct

    def test_forbidden_text_is_not_correct(self) -> None:
        item = score(row(forbidden=["returned"]), answered())
        assert not item.correct
        assert item.forbidden_seen == ["returned"]

    def test_invented_number_is_not_grounded(self) -> None:
        item = score(row(), answered(answer="Items can be returned within 99 days."))
        assert item.grounded is False

    def test_fake_citation_is_not_valid(self) -> None:
        item = score(row(), answered(source="FAKE-1"))
        assert item.citations_valid == 0

    def test_quote_not_in_source_is_not_valid(self) -> None:
        item = score(row(), answered(quote="Everything is free."))
        assert item.citations_valid == 0

    def test_refusal_has_no_groundedness(self) -> None:
        assert score(row(expected="refuse"), refused()).grounded is None


class TestSummary:
    def test_denominators_and_rates(self) -> None:
        scored = [
            score(row(required=["30 days"]), answered()),
            score(row(required=["30 days"]), refused()),
            score(row(id="D-UNA-01", category="unanswerable", expected="refuse"), refused()),
            score(row(id="D-UNA-02", category="unanswerable", expected="refuse"), answered()),
        ]
        metrics = summarise(scored)
        assert (
            metrics["answer_correctness"]["numerator"],
            metrics["answer_correctness"]["denominator"],
        ) == (1, 2)
        assert (
            metrics["refusal_precision"]["numerator"],
            metrics["refusal_precision"]["denominator"],
        ) == (1, 2)
        assert (
            metrics["refusal_recall"]["numerator"],
            metrics["refusal_recall"]["denominator"],
        ) == (1, 2)
        assert (
            metrics["false_refusal_rate"]["numerator"],
            metrics["false_refusal_rate"]["denominator"],
        ) == (1, 2)

    def test_empty_denominator_reports_no_rate(self) -> None:
        metric = summarise([])["refusal_precision"]
        assert metric["rate"] is None
        assert metric["ci95"] is None

    def test_a_perfect_small_sample_does_not_claim_certainty(self) -> None:
        low, high = wilson_interval(20, 20)
        assert high == 1.0
        assert low < 0.85


class TestRunner:
    def test_offline_run_reports_every_field(self) -> None:
        report = evaluate("dev", repeats=1)
        assert report["provider"] == "offline-extractive"
        assert report["model"] is None
        assert report["tokens"] is None
        assert report["estimated_cost_usd"] is None
        assert report["rows"] == len(load_split("dev"))
        assert report["latency_ms"]["samples"] == report["rows"]
        assert report["metrics"]["citation_validity"]["denominator"] > 0

    def test_metrics_can_actually_fail(self) -> None:
        """A bot that always answers with an invented claim must score badly, not well."""
        reply = json.dumps(
            {
                "status": "answered",
                "answer": "Everything is free forever.",
                "citations": [{"source_id": "RET-001", "quote": "Everything is free forever."}],
            }
        )
        report = evaluate("dev", provider=ScriptedProvider(reply), repeats=1)
        assert report["metrics"]["answer_correctness"]["rate"] == 0
        assert report["metrics"]["false_refusal_rate"]["rate"] > 0.9

    def test_a_model_that_agrees_with_everything_is_counted_on_usage(self) -> None:
        from testforge_ai.llm import Usage

        provider = ScriptedProvider("not json", model="scripted", usage=Usage(100, 10))
        report = evaluate("dev", provider=provider, repeats=1)
        assert report["provider"] == "scripted"
        assert report["tokens"]["input"] == 100 * report["tokens"]["calls"]
        assert report["tokens"]["calls"] > 0

    def test_inconsistent_provider_lowers_consistency(self) -> None:
        count = {"n": 0}

        def changing(_: dict) -> str:
            count["n"] += 1
            if count["n"] % 2:
                return "not json"
            quote = "Items can be returned within 30 days of delivery."
            return json.dumps(
                {
                    "status": "answered",
                    "answer": quote,
                    "citations": [{"source_id": "RET-001", "quote": quote}],
                }
            )

        report = evaluate("dev", provider=ScriptedProvider(changing), repeats=2)
        metric = report["metrics"]["response_consistency"]
        assert metric["numerator"] < metric["denominator"]

    def test_results_are_the_same_in_a_new_process_with_a_new_hash_seed(self) -> None:
        code = (
            "from testforge_ai.evaluation.runner import evaluate;"
            "print(evaluate('dev', repeats=1)['outputs_sha256'])"
        )
        digests = {
            subprocess.run(
                [sys.executable, "-c", code],
                env=os.environ | {"PYTHONHASHSEED": seed},
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()
            for seed in ("1", "2", "31337")
        }
        assert len(digests) == 1

    def test_dataset_directory_is_inside_the_repository(self) -> None:
        assert (DATASET_DIR / "dev.jsonl").exists()
