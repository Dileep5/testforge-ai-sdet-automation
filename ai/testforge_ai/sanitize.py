"""Make a copy of a Playwright run that is safe to publish, or drop what cannot be made safe.

Traces record what the browser and API client did, including session cookies, login passwords and
typed values. They are rewritten here, then scanned. A trace that still contains a known secret is
left out of the copy altogether, because a missing trace is better than a leaked credential.

Images and video cannot be scanned. Password fields are masked on screen, but other visible data is
not removed. All data in this project is synthetic.
"""

import base64
import json
import re
import shutil
import zipfile
from pathlib import Path
from typing import Any

from testforge_ai.safety import redact

REDACTED = "[REDACTED]"
_MIN_SECRET = 6
_SENSITIVE_HEADERS = {"cookie", "set-cookie", "authorization", "proxy-authorization", "x-api-key"}
_SENSITIVE_KEYS = re.compile(
    r"^(password|new_password|passwd|secret|client_secret|api_?key|access_token|refresh_token|"
    r"session_token|authorization|cookie)$",
    re.IGNORECASE,
)
# Traces also bundle the test's source files, which name the synthetic accounts' passwords.
_TEXT_MEMBER = (
    ".trace", ".network", ".stacks", ".json", ".html", ".md", ".txt", ".xml",
    ".ts", ".tsx", ".js", ".mjs", ".cjs", ".css", ".py",
)  # fmt: skip
_LEAK = re.compile(
    rb"testforge_session=(?!\[REDACTED)[A-Za-z0-9_-]{8,}|"
    rb"\"password\\*\"\s*:\s*\\*\"(?!\[REDACTED)[^\"\\]+|"
    rb"\bsk-[A-Za-z0-9_-]{16,}|"
    rb"(?:Admin|Manager|Viewer)!Forge2026"
)
_COPIED_SUFFIXES = {".png", ".jpeg", ".jpg", ".webm", ".md", ".txt", ".json", ".xml"}


def _remember(found: set[str], value: object) -> None:
    if isinstance(value, str) and len(value) >= _MIN_SECRET and value != REDACTED:
        found.add(value)


def _scrub_cookie_header(value: str, found: set[str]) -> None:
    for part in value.split(";"):
        _, separator, cookie = part.partition("=")
        if separator:
            _remember(found, cookie.strip())
    _remember(found, value)


def _scrub_json_text(text: str, found: set[str]) -> str:
    try:
        parsed = json.loads(text)
    except ValueError:
        return text
    if not isinstance(parsed, dict | list):
        return text
    return json.dumps(_scrub(parsed, found))


def _scrub(node: Any, found: set[str]) -> Any:
    """Redact by structure, and remember each value so that copies elsewhere can be replaced too."""
    if isinstance(node, list):
        return [_scrub(item, found) for item in node]
    if not isinstance(node, dict):
        return node

    is_named_value = isinstance(node.get("name"), str) and "value" in node
    if is_named_value and node["name"].lower() in _SENSITIVE_HEADERS:
        if isinstance(node["value"], str):
            _scrub_cookie_header(node["value"], found)
        return {**node, "value": REDACTED}

    # A password input in a DOM snapshot, and a fill aimed at one.
    if str(node.get("type", "")).lower() == "password":
        for key in ("value", "__playwright_value_"):
            if key in node:
                _remember(found, node[key])
                node = {**node, key: REDACTED}
    if "selector" in node and "value" in node and "password" in str(node["selector"]).lower():
        _remember(found, node["value"])
        node = {**node, "value": REDACTED}

    result: dict[str, Any] = {}
    for key, value in node.items():
        if key == "cookies" and isinstance(value, list):
            for cookie in value:
                if isinstance(cookie, dict):
                    _remember(found, cookie.get("value"))
            result[key] = [
                {**cookie, "value": REDACTED} if isinstance(cookie, dict) else REDACTED
                for cookie in value
            ]
        elif key in ("jsonData", "text") and isinstance(value, str):
            result[key] = _scrub_json_text(value, found)
        elif _SENSITIVE_KEYS.match(key) and isinstance(value, str):
            _remember(found, value)
            result[key] = REDACTED
        else:
            result[key] = _scrub(value, found)
    return result


def _replace_known(text: str, found: set[str]) -> str:
    # Longest first, so a value containing a shorter secret is replaced whole.
    for secret in sorted(found, key=len, reverse=True):
        text = text.replace(secret, REDACTED)
    return redact(text)


def _scrub_lines(raw: bytes, found: set[str]) -> str:
    lines = []
    for line in raw.decode("utf-8", errors="replace").splitlines():
        try:
            lines.append(json.dumps(_scrub(json.loads(line), found)))
        except ValueError:
            lines.append(line)
    return "\n".join(lines) + "\n"


def sanitize_trace(source: Path, target: Path) -> tuple[bool, int]:
    """Write a clean trace. Returns whether it was kept, and how many secrets were found."""
    found: set[str] = set()
    with zipfile.ZipFile(source) as archive:
        members = [(info, archive.read(info)) for info in archive.infolist()]

    cleaned: dict[str, str] = {}
    for info, raw in members:
        if info.filename.endswith((".trace", ".network")):
            cleaned[info.filename] = _scrub_lines(raw, found)
        elif info.filename.startswith("resources/") and info.filename.endswith(".json"):
            cleaned[info.filename] = _scrub_json_text(raw.decode("utf-8", errors="replace"), found)

    output: list[tuple[zipfile.ZipInfo, bytes]] = []
    for info, raw in members:
        if info.filename in cleaned:
            data = _replace_known(cleaned[info.filename], found).encode()
        elif info.filename.endswith(_TEXT_MEMBER):
            data = _replace_known(raw.decode("utf-8", errors="replace"), found).encode()
        else:
            # Binary, such as screencast frames and fonts. Text is still replaced if present.
            data = raw
            for secret in found:
                data = data.replace(secret.encode(), REDACTED.encode())
        output.append((info, data))

    secrets = [item.encode() for item in found]
    for _, data in output:
        if _LEAK.search(data) or any(secret in data for secret in secrets):
            return False, len(found)

    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for info, data in output:
            archive.writestr(info.filename, data)
    return True, len(found)


def _clean_report(source: Path, target: Path) -> None:
    report = json.loads(source.read_text(encoding="utf-8"))

    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(item) for item in node]
        if not isinstance(node, dict):
            return redact(node) if isinstance(node, str) else node
        body = node.get("body")
        if isinstance(body, str) and "contentType" in node:
            text = base64.b64decode(body).decode("utf-8", errors="replace")
            return {
                **{key: walk(value) for key, value in node.items() if key != "body"},
                "body": base64.b64encode(redact(text).encode()).decode(),
            }
        return {key: walk(value) for key, value in node.items()}

    target.write_text(json.dumps(walk(report)), encoding="utf-8")


def sanitize_run(run: Path, out: Path) -> dict[str, Any]:
    """Copy a run without its HTML report, which embeds raw traces. Never writes into the run."""
    if not run.is_dir():
        raise ValueError(f"No such run: {run}")
    if out.resolve().is_relative_to(run.resolve()):
        raise ValueError("The output folder must be outside the run")
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    summary: dict[str, Any] = {
        "traces_kept": 0,
        "traces_dropped": [],
        "secrets_replaced": 0,
        "files_copied": 0,
    }
    if (run / "playwright.json").exists():
        _clean_report(run / "playwright.json", out / "playwright.json")
        summary["files_copied"] += 1
    if (run / "junit.xml").exists():
        (out / "junit.xml").write_text(
            redact((run / "junit.xml").read_text(encoding="utf-8")), encoding="utf-8"
        )
        summary["files_copied"] += 1

    results = run / "test-results"
    for path in sorted(results.rglob("*")) if results.exists() else []:
        if not path.is_file():
            continue
        relative = path.relative_to(run)
        target = out / relative
        if path.suffix == ".zip":
            try:
                kept, secrets = sanitize_trace(path, target)
            except (zipfile.BadZipFile, OSError):
                kept, secrets = False, 0
            summary["secrets_replaced"] += secrets
            if kept:
                summary["traces_kept"] += 1
            else:
                summary["traces_dropped"].append(str(relative))
        elif path.suffix in _COPIED_SUFFIXES or path.suffix == "":
            target.parent.mkdir(parents=True, exist_ok=True)
            if path.suffix in (".md", ".txt", ".json", ".xml"):
                target.write_text(redact(path.read_text(errors="replace")), encoding="utf-8")
            else:
                shutil.copyfile(path, target)
            summary["files_copied"] += 1
    (out / "sanitize-report.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary
