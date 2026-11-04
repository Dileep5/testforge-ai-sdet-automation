"""Write approved cases as Playwright TypeScript skeletons that cannot pass or run on their own.

Four things keep a skeleton from executing: the .txt extension is outside every Playwright and
tsc pattern, each test is marked fixme, each body throws, and generated text appears only inside
JSON strings, so it stays data however hostile it is.
"""

import json
from pathlib import Path

from testforge_ai.generation.models import ReviewBundle, ReviewCase, ReviewStatus
from testforge_ai.generation.review import approval_problem

SENTINEL = "TESTFORGE-GENERATED-SKELETON-NOT-EXECUTABLE"
SKELETON_SUFFIX = ".skeleton.ts.txt"


class ExportRefused(Exception):
    pass


def _js(value: object) -> str:
    # U+2028 and U+2029 are escaped too: older parsers treat them as line ends inside strings.
    text = json.dumps(value, ensure_ascii=False, indent=2)
    return text.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def _render(case: ReviewCase) -> str:
    body = {
        "id": case.id,
        "requirementIds": case.case.requirement_ids,
        "category": case.case.category.value,
        "priority": case.case.priority,
        "preconditions": case.case.preconditions,
        "steps": case.case.steps,
        "expectedResults": case.case.expected_results,
        "approvedBy": case.decision.reviewer if case.decision else None,
    }
    return (
        f"test.fixme({_js(case.id + ': ' + case.case.title)}, async () => {{\n"
        f"  const reviewed = {_js(body)};\n"
        "  throw new Error(`Not implemented: write this test by hand. ${reviewed.id}`);\n"
        "});\n"
    )


def render_skeleton(bundle: ReviewBundle) -> str:
    """Refuses a pending, rejected or edited case. Rejected cases are left out only by choice."""
    chosen = [case for case in bundle.cases if case.status is not ReviewStatus.REJECTED]
    problems = [problem for case in chosen if (problem := approval_problem(bundle, case))]
    if problems:
        raise ExportRefused("; ".join(problems))
    if not chosen:
        raise ExportRefused("No approved cases to export")
    header = (
        f"// {SENTINEL}\n"
        f"// Requirement: {bundle.story.id}. Generator: {bundle.generator}.\n"
        "// To use a case: write the real steps and assertions in a new .spec.ts under tests/,\n"
        "// remove fixme and the throw, and have the result reviewed like any other test.\n"
        'import { test } from "@playwright/test";\n\n'
    )
    return header + "\n".join(_render(case) for case in chosen)


def export_skeleton(bundle: ReviewBundle, out_dir: Path) -> Path:
    content = render_skeleton(bundle)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{bundle.story.id}{SKELETON_SUFFIX}"
    path.write_text(content, encoding="utf-8")
    return path
