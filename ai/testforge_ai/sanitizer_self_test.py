"""Prove the sanitizer works without any test failing, using a synthetic run with dummy secrets.

The sanitizer normally runs only after a real failure, so a green CI run never exercises it. This
builds a run shaped like a real one, sanitizes it, and checks two things: every dummy secret is
gone, and the evidence needed to diagnose a failure is still there. A separate step can check the
same things again on what was actually uploaded.
"""

import base64
import json
import zipfile
from pathlib import Path
from typing import Any

from testforge_ai.sanitize import sanitize_run

# Made up for this test, and valid nowhere. Each sits in one place only, because the sanitizer
# replaces a secret everywhere once it finds it, which would hide a rule that had stopped working.
DUMMY_COOKIE = "dummy-session-cookie-0001"
DUMMY_PASSWORD = "Dummy-Login-Value-0002"  # noqa: S105
DUMMY_RESOURCE = "Dummy-Resource-Value-0006"
DUMMY_ATTACHMENT = "Dummy-Attachment-Value-0007"
DUMMY_CONTEXT = "Dummy-Context-Value-0008"
DUMMY_TYPED = "Dummy-Typed-Value-0003"
DUMMY_HEADER = "dummy-auth-header-0004"
DUMMY_API_KEY = "sk-" + "dummy" * 5
DUMMY_DOM = "Dummy-Snapshot-Value-0005"
SECRETS = (
    DUMMY_COOKIE,
    DUMMY_PASSWORD,
    DUMMY_TYPED,
    DUMMY_HEADER,
    DUMMY_API_KEY,
    DUMMY_DOM,
    DUMMY_RESOURCE,
    DUMMY_ATTACHMENT,
    DUMMY_CONTEXT,
)

# Non-secret details that a person diagnosing a failure needs.
EVIDENCE_IN_TRACE = (
    b'"method": "click"',
    b"/api/v1/orders",
    b"Cordless-Drill",
    b"element was detached",
)
PNG = b"\x89PNG\r\n\x1a\nsynthetic screenshot"
TEST_TITLE = "case S01 a synthetic failure"
SAFE_CASE = "safe-case"
UNSAFE_CASE = "unsafe-case"


def _write_trace(path: Path, *, unreadable_leak: bool = False) -> None:
    trace = [
        {
            "type": "before",
            "callId": "1",
            "class": "APIRequestContext",
            "method": "fetch",
            "params": {
                "jsonData": json.dumps({"email": "a@x.example", "password": DUMMY_PASSWORD})
            },
        },
        {
            "type": "before",
            "callId": "2",
            "class": "Frame",
            "method": "fill",
            "params": {"selector": 'internal:label="Password"', "value": DUMMY_TYPED},
        },
        {
            "type": "before",
            "callId": "3",
            "class": "Frame",
            "method": "fill",
            "params": {"selector": 'internal:label="Search"', "value": "Cordless-Drill"},
        },
        {
            "type": "before",
            "callId": "4",
            "class": "Frame",
            "method": "click",
            "params": {"selector": "button"},
        },
        {"type": "after", "callId": "4", "error": {"message": "element was detached"}},
        {
            "type": "frame-snapshot",
            "snapshot": {"html": ["INPUT", {"type": "password", "__playwright_value_": DUMMY_DOM}]},
        },
        {"type": "log", "callId": "1", "message": f"used key {DUMMY_API_KEY}"},
    ]
    network = {
        "type": "resource-snapshot",
        "snapshot": {
            "request": {
                "method": "GET",
                "url": "http://localhost:5273/api/v1/orders",
                "cookies": [{"name": "testforge_session", "value": DUMMY_COOKIE}],
                "headers": [
                    {"name": "Cookie", "value": f"testforge_session={DUMMY_COOKIE}"},
                    {"name": "Authorization", "value": DUMMY_HEADER},
                    {"name": "Accept", "value": "application/json"},
                ],
            },
            "response": {
                "status": 500,
                "headers": [{"name": "Set-Cookie", "value": f"testforge_session={DUMMY_COOKIE}"}],
            },
        },
    }
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("0-trace.trace", "\n".join(json.dumps(event) for event in trace) + "\n")
        archive.writestr("0-trace.network", json.dumps(network) + "\n")
        # Real traces hold request bodies here, and error context with no file extension.
        archive.writestr("resources/body.json", json.dumps({"password": DUMMY_RESOURCE}))
        archive.writestr("attachments/f423998edee3", f'password: "{DUMMY_ATTACHMENT}"\n')
        archive.writestr("resources/frame.jpeg", b"\xff\xd8\xff\x00binary")
        if unreadable_leak:
            archive.writestr("resources/blob.bin", b"\x00testforge_session=abcdefghij123456\x00")


def build_run(run: Path) -> None:
    """A run shaped like a real failed one, with secrets in each place real traces hold them."""
    for case, unsafe in ((SAFE_CASE, False), (UNSAFE_CASE, True)):
        folder = run / "test-results" / case
        folder.mkdir(parents=True)
        _write_trace(folder / "trace.zip", unreadable_leak=unsafe)
        (folder / "test-failed-1.png").write_bytes(PNG)
        (folder / "error-context.md").write_text(
            f'# Error\nElement was detached\n"password": "{DUMMY_CONTEXT}"\n', encoding="utf-8"
        )
    # The HTML report embeds raw traces, so it must never reach a public copy.
    html = run / "html" / "data"
    html.mkdir(parents=True)
    _write_trace(html / "raw.zip")
    (run / "html" / "index.html").write_text(f"<p>{DUMMY_COOKIE}</p>", encoding="utf-8")
    (run / "junit.xml").write_text(
        f'<testsuite><testcase name="{TEST_TITLE}"><failure>cookie: {DUMMY_COOKIE}</failure>'
        "</testcase></testsuite>",
        encoding="utf-8",
    )
    diagnostics = {"errorResponses": [{"status": 500}], "errors": [f"cookie: {DUMMY_COOKIE}"]}
    report = {
        "stats": {"expected": 0, "unexpected": 1, "flaky": 0, "skipped": 0},
        "title": TEST_TITLE,
        "errors": [f"Bearer {DUMMY_HEADER}"],
        "attachments": [
            {
                "name": "diagnostics",
                "contentType": "application/json",
                "body": base64.b64encode(json.dumps(diagnostics).encode()).decode(),
            }
        ],
    }
    (run / "playwright.json").write_text(json.dumps(report), encoding="utf-8")


def _contents(folder: Path) -> dict[str, bytes]:
    """Every file's bytes, including each member of each trace."""
    found: dict[str, bytes] = {}
    for path in folder.rglob("*"):
        if not path.is_file():
            continue
        name = str(path.relative_to(folder))
        if path.suffix == ".zip":
            with zipfile.ZipFile(path) as archive:
                for member in archive.namelist():
                    found[f"{name}:{member}"] = archive.read(member)
        else:
            found[name] = path.read_bytes()
    return found


def verify_public_copy(public: Path) -> list[str]:
    """What is wrong with a public copy. Names the secret's position, and never its value."""
    problems = []
    if not public.is_dir():
        return [f"No public copy at {public}"]
    contents = _contents(public)
    for name, data in contents.items():
        for index, secret in enumerate(SECRETS):
            if secret.encode() in data:
                problems.append(f"Dummy secret {index} is still in {name}")
    if (public / "html").exists():
        problems.append("The HTML report, which embeds raw traces, was copied")

    safe_trace = f"test-results/{SAFE_CASE}/trace.zip"
    unsafe_trace = f"test-results/{UNSAFE_CASE}/trace.zip"
    if (public / unsafe_trace).exists():
        problems.append("A trace that could not be cleaned was published")
    if not (public / safe_trace).exists():
        problems.append("A trace that could be cleaned was dropped")
    else:
        trace_text = b"\n".join(
            data for name, data in contents.items() if name.startswith(f"{safe_trace}:")
        )
        problems += [
            f"Evidence was lost from the trace: {item.decode()}"
            for item in EVIDENCE_IN_TRACE
            if item not in trace_text
        ]
    screenshot = public / "test-results" / SAFE_CASE / "test-failed-1.png"
    if not screenshot.exists() or screenshot.read_bytes() != PNG:
        problems.append("The screenshot was lost or changed")
    context = public / "test-results" / SAFE_CASE / "error-context.md"
    if not context.exists() or b"Element was detached" not in context.read_bytes():
        problems.append("The error context was lost")
    for name in ("junit.xml", "playwright.json"):
        path = public / name
        if not path.exists() or TEST_TITLE.encode() not in path.read_bytes():
            problems.append(f"{name} was lost")

    report_path = public / "sanitize-report.json"
    if not report_path.exists():
        problems.append("The sanitize report is missing")
    else:
        report = json.loads(report_path.read_text())
        if report["traces_kept"] != 1 or len(report["traces_dropped"]) != 1:
            problems.append(f"Expected 1 trace kept and 1 dropped, and got: {report}")
    return problems


def run_self_test(workdir: Path) -> dict[str, Any]:
    raw, public = workdir / "raw", workdir / "public"
    build_run(raw)
    # Without this, a run that never held secrets would pass for the wrong reason.
    raw_contents = b"\n".join(_contents(raw).values())
    missing = [index for index, secret in enumerate(SECRETS) if secret.encode() not in raw_contents]
    problems = [f"The raw run does not hold dummy secret {index}" for index in missing]
    summary = sanitize_run(raw, public)
    problems += verify_public_copy(public)
    return {"problems": problems, "sanitizer": summary, "public": str(public)}
