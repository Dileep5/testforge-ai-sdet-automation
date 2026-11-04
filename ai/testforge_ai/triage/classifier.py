"""Rule-based failure classification. Written against the development corpus only.

The result is a likely category with its evidence, for a person to check. Some failures look the
same from the artifacts, for example a renamed element and a wrong locator, so most results list
alternatives and ask for review.
"""

import re
from dataclasses import dataclass, field

from testforge_ai.triage.models import Category, EvidenceItem, FailureRecord, Triage

_ENV_HARD = re.compile(
    r"(browserType\.launch|Failed to launch|Executable doesn't exist|ERR_CONNECTION_REFUSED|"
    r"ECONNREFUSED|ECONNRESET|ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|"
    r"ERR_CONNECTION_RESET|ENOSPC|EADDRINUSE)"
)
_CLOSED = re.compile(r"(Target page, context or browser has been closed|Target closed)")
_TEST_TIMEOUT = re.compile(r"Test timeout of \d+ms exceeded")
_WAIT_TIMEOUT = re.compile(
    r"(page\.waitFor\w+|locator\.waitFor|page\.goto|page\.reload|frame\.goto): Timeout \d+ms"
)
_STRICT = re.compile(r"strict mode violation")
_NOT_FOUND = re.compile(
    r"(element\(s\) not found|(locator|page)\.\w+: Timeout \d+ms exceeded[\s\S]*waiting for )"
)
_VALUE_MISMATCH = re.compile(r"Locator: [\s\S]*Expected[^\n]*:[\s\S]*Received[^\n]*:")
_UNCAUGHT = re.compile(r"uncaught errors in the page")
_SETUP_LOGIN = re.compile(r"Login as \S+ failed: 4\d\d")
_API_REFUSAL = re.compile(
    r"(?:(?:GET|POST|PATCH|PUT|DELETE) /\S+ returned |Could not create[^:]*: |not found: )"
    r"(4\d\d)\b[^\n]{0,300}?\"code\":\s*\"([A-Z_]+)\""
)
_DATA_CODES = re.compile(
    r"\"code\":\s*\"([A-Z_]*(?:STOCK|DUPLICATE|EXISTS|TAKEN|CONFLICT)[A-Z_]*)\""
)


@dataclass
class _Evidence:
    items: list[EvidenceItem] = field(default_factory=list)

    def add(self, source: str, detail: str) -> None:
        self.items.append(
            EvidenceItem(id=f"E{len(self.items) + 1}", source=source, detail=detail[:400])
        )


_ADVICE = {
    Category.APPLICATION_REGRESSION: (
        "Reproduce by hand or call the failing endpoint directly. Check recent changes to it and "
        "the server log for the request id."
    ),
    Category.LOCATOR_ISSUE: (
        "Compare the locator with the page outline in error-context.md or the trace. Check whether "
        "the element was renamed on purpose before changing either side."
    ),
    Category.TIMING: (
        "Open the trace and see what was still running when the wait ended. Wait on the specific "
        "condition. Do not add sleeps or raise retries to hide it."
    ),
    Category.ENVIRONMENT: (
        "Check that the servers and browser are up and reachable, and rerun once they are. The "
        "failure says nothing yet about the application."
    ),
    Category.TEST_DATA: (
        "Check what the test set up against what the API refused. Confirm the data is unique to "
        "this test and that seeded records still exist."
    ),
    Category.UNKNOWN: "Read the error and stack trace. The rules found nothing to go on.",
}


def _first_line_with(pattern: re.Pattern[str], text: str) -> str:
    match = pattern.search(text)
    if not match:
        return ""
    start = text.rfind("\n", 0, match.start()) + 1
    end = text.find("\n", match.end())
    return text[start : end if end != -1 else None].strip()


def _result(
    record: FailureRecord,
    evidence: _Evidence,
    category: Category,
    confidence: str,
    uncertainty: str,
    alternatives: list[Category],
) -> Triage:
    return Triage(
        test=record.test,
        project=record.project,
        category=category,
        confidence=confidence,  # type: ignore[arg-type]
        uncertainty=uncertainty,
        alternatives=alternatives,
        evidence=evidence.items,
        suggested_investigation=_ADVICE[category],
        # Only an outright environment failure or ambiguous locator is settled by its own message.
        human_review_required=not (
            confidence == "high" and category in {Category.ENVIRONMENT, Category.LOCATOR_ISSUE}
        ),
    )


def classify(record: FailureRecord) -> Triage:
    """The test title is deliberately not read: a name must not decide what went wrong."""
    text = "\n".join(record.errors)
    evidence = _Evidence()
    server_errors = [
        call for call in record.error_responses if call.status is not None and call.status >= 500
    ]
    timed_out = bool(_TEST_TIMEOUT.search(text))

    if _ENV_HARD.search(text):
        evidence.add("error", _first_line_with(_ENV_HARD, text))
        return _result(
            record,
            evidence,
            Category.ENVIRONMENT,
            "high",
            "The message names a browser or connection failure before the app was tested.",
            [],
        )

    if record.page_errors or _UNCAUGHT.search(text):
        if record.page_errors:
            evidence.add("page_error", record.page_errors[0])
        if _UNCAUGHT.search(text):
            evidence.add("error", "The test fixture reported uncaught errors in the page")
        return _result(
            record,
            evidence,
            Category.APPLICATION_REGRESSION,
            "high",
            "An uncaught exception ran in the page. A test's injected script could also cause it.",
            [Category.UNKNOWN],
        )

    if server_errors:
        for call in server_errors[:5]:
            evidence.add("network", f"{call.method} {call.url} returned {call.status}")
        return _result(
            record,
            evidence,
            Category.APPLICATION_REGRESSION,
            "high",
            "A 5xx response shows the server failed, though an overload or outage looks the same.",
            [Category.ENVIRONMENT],
        )

    refused = _API_REFUSAL.search(text)
    data_code = _DATA_CODES.search(text)
    if _SETUP_LOGIN.search(text) or refused or data_code:
        line = _first_line_with(_SETUP_LOGIN, text) or (refused.group(0) if refused else "")
        evidence.add("error", line or (data_code.group(0) if data_code else ""))
        return _result(
            record,
            evidence,
            Category.TEST_DATA,
            "high" if data_code else "medium",
            "The API refused the test's own request. A bug in that API rule would look the same.",
            [Category.APPLICATION_REGRESSION],
        )

    pending = [call for call in record.pending_requests if "/api/" in call.url or call.url == "/"]
    if pending and not _STRICT.search(text):
        for call in pending[:5]:
            evidence.add("network", f"{call.method} {call.url} was still waiting at failure")
        if _NOT_FOUND.search(text):
            evidence.add("error", _first_line_with(_NOT_FOUND, text))
        return _result(
            record,
            evidence,
            Category.TIMING,
            "high" if timed_out else "medium",
            "A request was still waiting, but the cause may be a slow or hung server.",
            [Category.APPLICATION_REGRESSION, Category.ENVIRONMENT],
        )

    if timed_out:
        evidence.add("error", _first_line_with(_TEST_TIMEOUT, text))
        return _result(
            record,
            evidence,
            Category.TIMING,
            "medium",
            "The whole test ran out of time, without showing which step was waiting.",
            [Category.APPLICATION_REGRESSION, Category.UNKNOWN],
        )

    if _WAIT_TIMEOUT.search(text):
        evidence.add("error", _first_line_with(_WAIT_TIMEOUT, text))
        return _result(
            record,
            evidence,
            Category.TIMING,
            "medium",
            "An expected event never came, which a missing request would also explain.",
            [Category.APPLICATION_REGRESSION, Category.UNKNOWN],
        )

    if _STRICT.search(text):
        evidence.add("error", _first_line_with(_STRICT, text))
        return _result(
            record,
            evidence,
            Category.LOCATOR_ISSUE,
            "high",
            "The locator matched several elements, so it is ambiguous whatever the page shows.",
            [],
        )

    if _VALUE_MISMATCH.search(text):
        evidence.add("error", _first_line_with(re.compile(r"Received[^\n]*:"), text))
        return _result(
            record,
            evidence,
            Category.APPLICATION_REGRESSION,
            "medium",
            "The element has a different value. Wrong test data or expectations look the same.",
            [Category.TEST_DATA],
        )

    if _NOT_FOUND.search(text):
        evidence.add("error", _first_line_with(_NOT_FOUND, text))
        locator = _first_line_with(re.compile(r"(Locator: |waiting for )"), text)
        if locator:
            evidence.add("error", locator)
        return _result(
            record,
            evidence,
            Category.LOCATOR_ISSUE,
            "medium",
            "The element was missing with no server errors. The app may have stopped rendering it.",
            [Category.APPLICATION_REGRESSION, Category.TIMING],
        )

    if _CLOSED.search(text):
        evidence.add("error", _first_line_with(_CLOSED, text))
        return _result(
            record,
            evidence,
            Category.ENVIRONMENT,
            "medium",
            "The browser or page closed under the test, by a crash or by the test's own code.",
            [Category.UNKNOWN],
        )

    if record.errors:
        evidence.add("error", record.errors[0].split("\n")[0])
    return _result(
        record,
        evidence,
        Category.UNKNOWN,
        "low",
        "No rule matched, so this needs reading by a person.",
        list(Category)[:-1],
    )
