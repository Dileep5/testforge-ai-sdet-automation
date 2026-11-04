"""Read real Playwright output and keep only what is needed, redacted.

Traces hold live session cookies and, in login steps, passwords. So they are read by allow-list:
action names, errors, methods, paths and statuses come out, and nothing else does.
"""

import base64
import json
import re
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from defusedxml import ElementTree

from testforge_ai.safety import redact
from testforge_ai.triage.models import ApiCall, FailureRecord, TraceSummary

MAX_REPORT_BYTES = 200 * 1024 * 1024
MAX_TRACE_MEMBER_BYTES = 50 * 1024 * 1024
MAX_ERROR_CHARS = 4000
MAX_SNAPSHOT_CHARS = 4000
MAX_LIST = 50

_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
_ATTACHMENT = re.compile(r"\[\[ATTACHMENT\|([^\]]+)\]\]")
_FAILED_STATUSES = {"failed", "timedOut", "interrupted"}


class ArtifactError(Exception):
    pass


def clean(text: str, limit: int = MAX_ERROR_CHARS) -> str:
    return redact(_ANSI.sub("", text))[:limit]


def _path_only(url: str) -> str:
    """Query strings can carry search text and tokens, so only the path is kept."""
    parts = urlsplit(url)
    if parts.hostname in ("127.0.0.1", "localhost"):
        return parts.path or "/"
    return f"{parts.hostname or ''}{parts.path}"


def _inside(path: Path, root: Path) -> bool:
    """A report is input too: its attachment paths must not lead outside the artifacts folder."""
    try:
        return path.resolve().is_relative_to(root.resolve())
    except OSError:
        return False


def summarise_trace(path: Path) -> TraceSummary | None:
    try:
        with zipfile.ZipFile(path) as archive:
            return _read_trace(archive)
    except (zipfile.BadZipFile, OSError, ValueError):
        return None


def _read_trace(archive: zipfile.ZipFile) -> TraceSummary:
    started: dict[str, str] = {}
    finished: set[str] = set()
    failed: list[str] = []
    http_errors: list[ApiCall] = []
    for info in archive.infolist():
        name = info.filename
        if "/" in name or not name.endswith((".trace", ".network")):
            continue
        if info.file_size > MAX_TRACE_MEMBER_BYTES:
            continue
        with archive.open(info) as member:
            for raw in member:
                try:
                    event = json.loads(raw)
                except ValueError:
                    continue
                kind = event.get("type")
                if kind == "before":
                    label = f"{event.get('class', '')}.{event.get('method', '')}"
                    started[str(event.get("callId"))] = label
                elif kind == "after":
                    call = str(event.get("callId"))
                    finished.add(call)
                    error = event.get("error")
                    if isinstance(error, dict):
                        label = started.get(call, "unknown")
                        failed.append(clean(f"{label}: {error.get('message', '')}", 300))
                elif kind == "resource-snapshot":
                    snapshot = event.get("snapshot", {})
                    status = snapshot.get("response", {}).get("status", 0)
                    if status >= 400:
                        request = snapshot.get("request", {})
                        http_errors.append(
                            ApiCall(
                                method=str(request.get("method", "")),
                                url=_path_only(str(request.get("url", ""))),
                                status=status,
                            )
                        )
    return TraceSummary(
        actions_total=len(started),
        failed_actions=failed[:MAX_LIST],
        unfinished_actions=[v for k, v in started.items() if k not in finished][:MAX_LIST],
        http_errors=http_errors[:MAX_LIST],
    )


def _page_snapshot(path: Path) -> str | None:
    """Only the page outline. The file's opening text is written for chat tools, and is not data."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    match = re.search(r"```yaml\n(.*?)```", text, re.DOTALL)
    return clean(match.group(1), MAX_SNAPSHOT_CHARS) if match else None


def _calls(items: list[dict[str, Any]]) -> list[ApiCall]:
    return [
        ApiCall(
            method=str(item.get("method", "")),
            url=_path_only(str(item.get("url", ""))),
            status=item.get("status"),
            failure=item.get("failure"),
        )
        for item in items[:MAX_LIST]
    ]


def _apply_diagnostics(record: dict[str, Any], report: dict[str, Any]) -> None:
    for page in report.get("pages", []):
        record["console_errors"] += [
            clean(str(i.get("text", "")), 500) for i in page.get("consoleErrors", [])
        ]
        record["page_errors"] += [clean(str(i), 800) for i in page.get("pageErrors", [])]
        record["failed_requests"] += _calls(page.get("failedRequests", []))
        record["error_responses"] += _calls(page.get("errorResponses", []))
        record["pending_requests"] += _calls(page.get("pendingRequests", []))


def _record_from_json(
    spec: dict[str, Any],
    test: dict[str, Any],
    result: dict[str, Any],
    root: Path,
    read_traces: bool,
) -> FailureRecord:
    record: dict[str, Any] = {
        "test": clean(str(spec.get("title", "")), 300),
        "project": str(test.get("projectName", "")),
        "status": str(result.get("status", "")),
        "errors": [clean(str(item.get("message", ""))) for item in result.get("errors", [])],
        "console_errors": [],
        "page_errors": [],
        "failed_requests": [],
        "error_responses": [],
        "pending_requests": [],
        "sources": ["playwright-json"],
    }
    for attachment in result.get("attachments", []):
        name = attachment.get("name")
        path = Path(attachment["path"]) if attachment.get("path") else None
        safe_path = path if path is not None and _inside(path, root) else None
        if name == "diagnostics":
            body = attachment.get("body")
            raw = base64.b64decode(body) if body else None
            if raw is None and safe_path is not None and safe_path.exists():
                raw = safe_path.read_bytes()
            if raw:
                try:
                    _apply_diagnostics(record, json.loads(raw))
                except ValueError:
                    continue
                record["sources"].append("diagnostics")
        elif name == "trace" and safe_path is not None and read_traces and safe_path.exists():
            summary = summarise_trace(safe_path)
            if summary:
                record["trace"] = summary
                record["sources"].append("trace")
        elif name == "error-context" and safe_path is not None and safe_path.exists():
            record["page_snapshot"] = _page_snapshot(safe_path)
            record["sources"].append("error-context")
        elif name == "screenshot" and safe_path is not None:
            # A path only. The image goes nowhere unless a vision model is configured and asked for.
            record["screenshot"] = str(safe_path)
    return FailureRecord(**record)


def _walk(suite: dict[str, Any]):
    for spec in suite.get("specs", []):
        for test in spec.get("tests", []):
            for result in test.get("results", []):
                yield spec, test, result
    for child in suite.get("suites", []):
        yield from _walk(child)


def _check_size(path: Path) -> None:
    if path.stat().st_size > MAX_REPORT_BYTES:
        raise ArtifactError(f"{path.name} is larger than the {MAX_REPORT_BYTES} byte limit")


def load_json_report(
    path: Path, artifacts_root: Path | None = None, read_traces: bool = True
) -> list[FailureRecord]:
    _check_size(path)
    try:
        report = json.loads(path.read_bytes())
    except ValueError:
        raise ArtifactError(f"{path.name} is not valid JSON") from None
    root = artifacts_root or path.parent
    records = []
    for suite in report.get("suites", []):
        for spec, test, result in _walk(suite):
            if result.get("status") in _FAILED_STATUSES:
                records.append(_record_from_json(spec, test, result, root, read_traces))
    return records


def load_junit(path: Path) -> list[FailureRecord]:
    """JUnit alone gives less: there are no diagnostics, so classification relies on the message."""
    _check_size(path)
    try:
        tree = ElementTree.parse(path)
    except (ElementTree.ParseError, ValueError):
        # defusedxml raises a ValueError for entity expansion and external references.
        raise ArtifactError(f"{path.name} is not valid or safe XML") from None
    records = []
    for suite in tree.getroot().iter("testsuite"):
        for case in suite.iter("testcase"):
            problems = [*case.findall("failure"), *case.findall("error")]
            if not problems:
                continue
            records.append(
                FailureRecord(
                    test=clean(case.get("name", ""), 300),
                    project=suite.get("hostname", ""),
                    status="failed",
                    errors=[clean(item.text or item.get("message", "")) for item in problems],
                    sources=["junit"],
                )
            )
    return records


def junit_attachments(path: Path) -> list[str]:
    return _ATTACHMENT.findall(path.read_text(encoding="utf-8", errors="replace"))


def load_run(
    *,
    json_report: Path | None = None,
    junit: Path | None = None,
    artifacts_root: Path | None = None,
) -> list[FailureRecord]:
    """The JSON report is richer. JUnit adds any failure the JSON report does not contain."""
    if json_report is None and junit is None:
        raise ArtifactError("Give a Playwright JSON report, a JUnit file or both")
    records = load_json_report(json_report, artifacts_root) if json_report else []
    if junit:
        known = {(item.test, item.project) for item in records}
        records += [item for item in load_junit(junit) if (item.test, item.project) not in known]
    return records
