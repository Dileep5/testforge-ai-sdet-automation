"""Command line for test generation, review, chat, evaluation and failure triage."""

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from testforge_ai.chatbot.bot import SupportBot
from testforge_ai.evaluation.judge import judge_groundedness
from testforge_ai.evaluation.runner import evaluate, run_row, tune
from testforge_ai.generation.exporter import ExportRefused, export_skeleton
from testforge_ai.generation.pipeline import GenerationRejected, build_bundle, generate, load_story
from testforge_ai.generation.review import (
    ReviewError,
    approve,
    load_bundle,
    reject,
    save_bundle,
)
from testforge_ai.llm import LLMError, OpenAIProvider
from testforge_ai.sanitize import sanitize_run
from testforge_ai.sanitizer_self_test import run_self_test, verify_public_copy
from testforge_ai.triage.artifacts import ArtifactError, load_run
from testforge_ai.triage.assist import assist
from testforge_ai.triage.classifier import classify
from testforge_ai.triage.scoring import score_corpus


def _print(value: Any) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=False))  # noqa: T201


def _write(path: Path | None, value: Any) -> None:
    if path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _provider(args: argparse.Namespace) -> OpenAIProvider | None:
    return OpenAIProvider.from_env(args.model) if args.provider == "openai" else None


def _cmd_generate(args: argparse.Namespace) -> int:
    story = load_story(args.story)
    if args.provider == "fixture":
        if not args.fixture:
            raise GenerationRejected("no_fixture", "--provider fixture needs --fixture")
        bundle = build_bundle(story, args.fixture.read_text(encoding="utf-8"), "fixture")
    else:
        bundle = generate(
            story, provider=_provider(args), allow_flagged_story=args.allow_flagged_story
        )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    save_bundle(bundle, args.out)
    _print(
        {
            "generator": bundle.generator,
            "model": bundle.model,
            "accepted": len(bundle.cases),
            "rejected": [item.model_dump() for item in bundle.rejected],
            "flagged": {
                case.id: [flag.kind for flag in case.flags] for case in bundle.cases if case.flags
            },
            "story_flags": bundle.story_flags,
            "coverage": bundle.coverage.model_dump(),
            "next": "Review with `testforge-ai review`. Nothing has been approved or executed.",
        }
    )
    return 0


def _cmd_review(args: argparse.Namespace) -> int:
    bundle = load_bundle(args.bundle)
    if args.action == "list":
        _print(
            [
                {
                    "id": case.id,
                    "status": case.status.value,
                    "category": case.case.category.value,
                    "priority": case.case.priority,
                    "title": case.case.title,
                    "requirements": case.case.requirement_ids,
                    "flags": [f"{flag.kind}: {flag.detail}" for flag in case.flags],
                }
                for case in bundle.cases
            ]
        )
        return 0
    if args.action == "approve":
        for case_id in args.case:
            approve(bundle, case_id, args.reviewer, args.note, args.acknowledge_flags)
    else:
        for case_id in args.case:
            reject(bundle, case_id, args.reviewer, args.note)
    save_bundle(bundle, args.bundle)
    _print({"updated": args.case, "status": args.action})
    return 0


def _cmd_export(args: argparse.Namespace) -> int:
    path = export_skeleton(load_bundle(args.bundle), args.out)
    _print({"wrote": str(path), "note": "Not executable. Write the real test by hand."})
    return 0


def _cmd_chat(args: argparse.Namespace) -> int:
    print(SupportBot(provider=_provider(args)).answer(args.question).model_dump_json(indent=2))  # noqa: T201
    return 0


def _cmd_eval(args: argparse.Namespace) -> int:
    if args.tune:
        _print(tune())
        return 0
    provider = _provider(args)
    report = evaluate(args.split, provider=provider, repeats=args.repeats)
    if args.judge:
        if provider is None:
            raise LLMError("--judge needs --provider openai")
        from testforge_ai.evaluation.dataset import load_split
        from testforge_ai.evaluation.runner import RetrievalConfig

        responses = [run_row(row, provider, RetrievalConfig()) for row in load_split(args.split)]
        report["model_graded_groundedness"] = judge_groundedness(responses, provider)
    _write(args.out, report)
    _print(report)
    return 0


def _cmd_triage(args: argparse.Namespace) -> int:
    records = load_run(json_report=args.json, junit=args.junit, artifacts_root=args.artifacts_root)
    if args.snapshot:
        _write(args.snapshot, [item.model_dump(exclude={"screenshot"}) for item in records])
    provider = _provider(args)
    results = []
    for record in records:
        triage = classify(record)
        if provider:
            triage = assist(record, triage, provider, use_screenshot=args.vision)
        results.append(triage)
    output: dict[str, Any] = {
        "failures": len(results),
        "results": [item.model_dump(mode="json") for item in results],
    }
    if args.score:
        output["score"] = score_corpus(results, args.score)
    _write(args.out, output)
    _print(output["score"] if args.score else output)
    return 0


def _cmd_sanitize(args: argparse.Namespace) -> int:
    summary = sanitize_run(args.run_dir, args.out)
    _print(summary)
    return 0


def _cmd_self_test(args: argparse.Namespace) -> int:
    if args.verify_only:
        problems = verify_public_copy(args.verify_only)
    elif args.workdir:
        result = run_self_test(args.workdir)
        problems = result["problems"]
        _print(result["sanitizer"])
    else:
        raise ValueError("Give --workdir or --verify-only")
    _print({"passed": not problems, "problems": problems})
    return 1 if problems else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="testforge-ai", description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    def provider_args(command: argparse.ArgumentParser, *extra: str) -> None:
        command.add_argument("--provider", choices=["offline", "openai", *extra], default="offline")
        command.add_argument("--model", help="Live mode only. Or set OPENAI_MODEL.")

    generate_cmd = commands.add_parser("generate", help="Create candidate tests for review")
    generate_cmd.add_argument("--story", type=Path, required=True)
    generate_cmd.add_argument("--out", type=Path, required=True)
    generate_cmd.add_argument("--fixture", type=Path)
    generate_cmd.add_argument("--allow-flagged-story", action="store_true")
    provider_args(generate_cmd, "fixture")
    generate_cmd.set_defaults(run=_cmd_generate)

    review = commands.add_parser("review", help="List, approve or reject candidate tests")
    review.add_argument("action", choices=["list", "approve", "reject"])
    review.add_argument("--bundle", type=Path, required=True)
    review.add_argument("--case", action="append", default=[])
    review.add_argument("--reviewer", default="")
    review.add_argument("--note", default="")
    review.add_argument("--acknowledge-flags", action="store_true")
    review.set_defaults(run=_cmd_review)

    export = commands.add_parser("export", help="Write approved cases as non-executable skeletons")
    export.add_argument("--bundle", type=Path, required=True)
    export.add_argument("--out", type=Path, required=True)
    export.set_defaults(run=_cmd_export)

    chat = commands.add_parser("chat", help="Ask the support chatbot one question")
    chat.add_argument("question")
    provider_args(chat)
    chat.set_defaults(run=_cmd_chat)

    evaluation = commands.add_parser("eval", help="Evaluate the chatbot")
    evaluation.add_argument("--split", choices=["dev", "heldout"], default="dev")
    evaluation.add_argument("--repeats", type=int, default=3)
    evaluation.add_argument("--out", type=Path)
    evaluation.add_argument("--tune", action="store_true", help="Sweep settings on the dev split")
    evaluation.add_argument("--judge", action="store_true", help="Add a model-graded check")
    provider_args(evaluation)
    evaluation.set_defaults(run=_cmd_eval)

    triage = commands.add_parser("triage", help="Classify failures from Playwright artifacts")
    triage.add_argument("--json", type=Path)
    triage.add_argument("--junit", type=Path)
    triage.add_argument("--artifacts-root", type=Path)
    triage.add_argument("--out", type=Path)
    triage.add_argument(
        "--snapshot", type=Path, help="Save the redacted records for regression tests"
    )
    triage.add_argument("--vision", action="store_true", help="Send screenshots to the live model")
    triage.add_argument("--score", choices=["dev", "heldout"], help="Score against corpus labels")
    provider_args(triage)
    triage.set_defaults(run=_cmd_triage)

    sanitize = commands.add_parser("sanitize", help="Make a copy of a run that is safe to publish")
    sanitize.add_argument("--run-dir", type=Path, required=True)
    sanitize.add_argument("--out", type=Path, required=True)
    sanitize.set_defaults(run=_cmd_sanitize)

    self_test = commands.add_parser(
        "sanitize-self-test", help="Check the sanitizer on a synthetic run with dummy secrets"
    )
    self_test.add_argument("--workdir", type=Path, help="Build, sanitize and check a synthetic run")
    self_test.add_argument(
        "--verify-only", type=Path, help="Check a public copy, such as a download"
    )
    self_test.set_defaults(run=_cmd_self_test)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.run(args)
    except (
        GenerationRejected,
        ReviewError,
        ExportRefused,
        ArtifactError,
        LLMError,
        ValueError,
    ) as exc:
        print(f"Refused: {exc}", file=sys.stderr)  # noqa: T201
        return 2


if __name__ == "__main__":
    sys.exit(main())
