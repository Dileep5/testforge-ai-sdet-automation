"""A deterministic generator based on templates. It is not AI, and it is labelled as such.

It lets the whole workflow run without credentials. It restates the acceptance criteria, so a
reviewer still has to decide how each one is actually exercised.
"""

import json
import re

from testforge_ai.generation.models import GeneratedCase, UserStory

_RESTRICTIVE = re.compile(
    r"\b(must|only|cannot|can't|not|never|reject|refuse|required|invalid|at least|at most|"
    r"no more than|fewer than|greater than|less than)\b",
    re.IGNORECASE,
)
_INTEGER = re.compile(r"(?<![\w.-])\d{1,9}(?![\w.-]*\d)")


def generate_offline(story: UserStory) -> str:
    """Return JSON text so that the output goes through the same parsing as a model's."""
    cases = [_serialise(case) for case in _cases(story)]
    return json.dumps({"story_id": story.id, "cases": cases}, ensure_ascii=False)


def _serialise(case: GeneratedCase) -> dict[str, object]:
    return case.model_dump(mode="json")


def _cases(story: UserStory) -> list[GeneratedCase]:
    role = story.allowed_roles[0]
    signed_in = f"Signed in as {role}"
    cases: list[GeneratedCase] = []
    for criterion in story.acceptance_criteria:
        requirement = f"{story.id}/{criterion.id}"
        cases.append(
            GeneratedCase(
                title=f"{criterion.id} holds for {role}",
                category="positive",
                priority="P1",
                requirement_ids=[requirement],
                preconditions=[signed_in],
                steps=[f"Perform the action this criterion describes: {criterion.text}"],
                expected_results=[criterion.text],
                assumptions=[],
            )
        )
        if _RESTRICTIVE.search(criterion.text):
            cases.append(
                GeneratedCase(
                    title=f"{criterion.id} is enforced when violated",
                    category="negative",
                    priority="P1",
                    requirement_ids=[requirement],
                    preconditions=[signed_in],
                    steps=[f"Attempt to break this rule: {criterion.text}"],
                    expected_results=[
                        "The attempt is refused and nothing changes",
                        f"This rule still holds: {criterion.text}",
                    ],
                    assumptions=[],
                )
            )
        for number in _integers(criterion.text):
            cases.append(
                GeneratedCase(
                    title=f"{criterion.id} at the limit {number}",
                    category="boundary",
                    priority="P2",
                    requirement_ids=[requirement],
                    preconditions=[signed_in],
                    steps=[
                        f"Try {value} for this rule: {criterion.text}"
                        for value in (number - 1, number, number + 1)
                    ],
                    expected_results=[f"Each value follows this rule: {criterion.text}"],
                    assumptions=[],
                )
            )
    every_requirement = sorted(story.requirement_ids())
    for forbidden in story.forbidden_roles:
        cases.append(
            GeneratedCase(
                title=f"{forbidden} cannot do this",
                category="authorization",
                priority="P1",
                requirement_ids=every_requirement,
                preconditions=[f"Signed in as {forbidden}"],
                steps=[f"Attempt this as {forbidden}: {story.i_want}"],
                expected_results=["The attempt is refused and nothing changes"],
                assumptions=[],
            )
        )
    if story.surface in ("ui", "both"):
        cases.append(
            GeneratedCase(
                title=f"{story.title} works by keyboard and passes automated checks",
                category="accessibility",
                priority="P2",
                requirement_ids=every_requirement,
                preconditions=[signed_in],
                steps=[
                    f"Complete this using only the keyboard: {story.i_want}",
                    "Run an automated accessibility scan on each state",
                ],
                expected_results=[
                    "Focus is visible and follows a logical order",
                    "The scan reports no violations, which does not prove conformance",
                ],
                assumptions=[],
            )
        )
    return cases


def _integers(text: str) -> list[int]:
    return sorted({int(match) for match in _INTEGER.findall(text)})
