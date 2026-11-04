"""Human review. Approval is tied to the exact case and story, so later edits void it."""

from datetime import UTC, datetime
from pathlib import Path

from testforge_ai.generation.models import Decision, ReviewBundle, ReviewCase, ReviewStatus

_NOT_A_PERSON = {"auto", "automatic", "bot", "ci", "llm", "model", "system", "ai", "openai"}


class ReviewError(Exception):
    pass


def load_bundle(path: Path) -> ReviewBundle:
    return ReviewBundle.model_validate_json(path.read_bytes())


def save_bundle(bundle: ReviewBundle, path: Path) -> None:
    path.write_text(bundle.model_dump_json(indent=2) + "\n", encoding="utf-8")


def _find(bundle: ReviewBundle, case_id: str) -> ReviewCase:
    for case in bundle.cases:
        if case.id == case_id:
            return case
    raise ReviewError(f"No case {case_id} in this bundle")


def _decision(bundle: ReviewBundle, case: ReviewCase, reviewer: str, note: str) -> Decision:
    name = reviewer.strip()
    if not name or name.lower() in _NOT_A_PERSON:
        raise ReviewError("Decisions must name the person who reviewed the case")
    return Decision(
        reviewer=name,
        note=note,
        decided_at=datetime.now(UTC).isoformat(),
        case_sha256=case.digest(),
        story_sha256=bundle.story.digest(),
    )


def approve(
    bundle: ReviewBundle,
    case_id: str,
    reviewer: str,
    note: str = "",
    acknowledge_flags: bool = False,
) -> None:
    case = _find(bundle, case_id)
    if case.flags and not acknowledge_flags:
        kinds = ", ".join(sorted({flag.kind for flag in case.flags}))
        raise ReviewError(f"{case_id} has flags to acknowledge first: {kinds}")
    if case.flags and not note.strip():
        raise ReviewError(f"{case_id} has flags, so approving it needs a note explaining why")
    case.decision = _decision(bundle, case, reviewer, note)
    case.status = ReviewStatus.APPROVED


def reject(bundle: ReviewBundle, case_id: str, reviewer: str, note: str) -> None:
    if not note.strip():
        raise ReviewError("A rejection needs a reason")
    case = _find(bundle, case_id)
    case.decision = _decision(bundle, case, reviewer, note)
    case.status = ReviewStatus.REJECTED


def approval_problem(bundle: ReviewBundle, case: ReviewCase) -> str | None:
    """Why this case may not be exported, or None if it may."""
    if case.status is not ReviewStatus.APPROVED or case.decision is None:
        return f"{case.id} is {case.status.value}, not approved"
    if case.decision.case_sha256 != case.digest():
        return f"{case.id} changed after it was approved"
    if case.decision.story_sha256 != bundle.story.digest():
        return f"The story changed after {case.id} was approved"
    return None
