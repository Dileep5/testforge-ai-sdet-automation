#!/usr/bin/env python3
"""Rules for the CI and Docker files. Each one stops a way of hiding failures or leaking secrets."""

import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
_PINNED_ACTION = re.compile(r"^[\w./-]+@[0-9a-f]{40}$")
_PINNED_IMAGE = re.compile(r"@sha256:[0-9a-f]{64}$")
# Words that hide a failing command or a failing job.
_PERMISSIVE = re.compile(r"\|\|\s*(true|:|exit 0)|set \+e|continue-on-error")
_UPLOAD = "actions/upload-artifact"


def _steps(workflow: dict) -> list[dict]:
    found = []
    for job in (workflow.get("jobs") or {}).values():
        found.extend(job.get("steps") or [])
    return found


def check_workflow(path: str, text: str) -> list[str]:
    problems = []
    workflow = yaml.safe_load(text)
    triggers = workflow.get(True, workflow.get("on"))  # YAML reads a bare "on" as True.
    triggers = [triggers] if isinstance(triggers, str) else triggers
    if "permissions" not in workflow:
        problems.append(f"{path}: no top-level permissions")
    elif any(value == "write" for value in dict(workflow["permissions"]).values()):
        problems.append(f"{path}: write permission granted")
    if "pull_request_target" in (triggers or []):
        problems.append(f"{path}: pull_request_target exposes secrets to untrusted code")
    if _PERMISSIVE.search(text):
        problems.append(f"{path}: a command or job is allowed to fail silently")
    if "secrets." in text:
        problems.append(f"{path}: uses a repository secret")
    if re.search(r"OPENAI_API_KEY|TESTFORGE_ALLOW_LIVE_LLM:\s*[\"']?1", text):
        problems.append(f"{path}: enables a live model")
    for retries in re.findall(r"E2E_RETRIES:\s*[\"']?(\d+)", text):
        if retries != "0":
            problems.append(f"{path}: retries are not 0")
    for step in _steps(workflow):
        uses = step.get("uses", "")
        if uses and not uses.startswith("./") and not _PINNED_ACTION.match(uses):
            problems.append(f"{path}: action not pinned to a full commit: {uses}")
        if uses.startswith(_UPLOAD):
            options = step.get("with", {})
            if "retention-days" not in options:
                problems.append(f"{path}: upload has no retention period")
            upload = str(options.get("path", ""))
            if "reports/runs" in upload or "html" in upload or "test-results" in upload:
                problems.append(f"{path}: uploads raw artifacts, which hold credentials: {upload}")
    for name, job in (workflow.get("jobs") or {}).items():
        if "uses" not in job and "timeout-minutes" not in job:
            problems.append(f"{path}: job {name} has no timeout")
        image = (job.get("services") or {}).get("postgres", {}).get("image", "")
        if image and not _PINNED_IMAGE.search(image):
            problems.append(f"{path}: service image not pinned by digest: {image}")
    return problems


def check_concurrency(path: str, text: str) -> list[str]:
    """A push to main must never cancel, or wait on, another run. Its result has to be kept."""
    concurrency = yaml.safe_load(text).get("concurrency", {})
    problems = []
    cancel = str(concurrency.get("cancel-in-progress", False))
    if cancel == "True" or "pull_request" not in cancel:
        problems.append(f"{path}: cancelling must apply to pull requests only")
    if "github.sha" not in str(concurrency.get("group", "")):
        problems.append(f"{path}: pushes to main need a concurrency group of their own")
    return problems


def check_action(path: str, text: str) -> list[str]:
    problems = []
    for step in yaml.safe_load(text)["runs"]["steps"]:
        uses = step.get("uses", "")
        if uses and not uses.startswith("./") and not _PINNED_ACTION.match(uses):
            problems.append(f"{path}: action not pinned to a full commit: {uses}")
    if _PERMISSIVE.search(text):
        problems.append(f"{path}: a command is allowed to fail silently")
    return problems


def check_dockerfile(path: str, text: str) -> list[str]:
    problems = []
    for line in text.splitlines():
        if line.startswith("FROM ") and not re.search(r"@sha256:[0-9a-f]{64}", line):
            problems.append(f"{path}: base image not pinned by digest: {line}")
        if re.match(r"(ENV|ARG)\b.*(PASSWORD|SECRET|API_KEY|TOKEN)", line, re.IGNORECASE):
            problems.append(f"{path}: credential in the image: {line}")
    if "USER " not in text and "nginx-unprivileged" not in text:
        problems.append(f"{path}: runs as root")
    return problems


def check_compose(path: str, text: str, *, test_stack: bool) -> list[str]:
    problems = []
    compose = yaml.safe_load(text)
    for name, service in compose["services"].items():
        image = service.get("image", "")
        built_here = image.startswith("testforge-")
        if image and not built_here and not _PINNED_IMAGE.search(image):
            problems.append(f"{path}: {name} image not pinned by digest: {image}")
        for port in service.get("ports", []):
            if not str(port).startswith("127.0.0.1:"):
                problems.append(f"{path}: {name} publishes a port beyond this machine: {port}")
    database = compose["services"]["db"]
    if "healthcheck" not in database:
        problems.append(f"{path}: the database has no health check")
    if "ports" in database:
        problems.append(f"{path}: the database must not be published")
    if test_stack:
        if database["environment"]["POSTGRES_DB"] != "testforge_e2e":
            problems.append(f"{path}: the test database must be named for E2E")
        if "tmpfs" not in database:
            problems.append(f"{path}: the test database must not persist")
    else:
        password = str(database["environment"]["POSTGRES_PASSWORD"])
        if not password.startswith("${"):
            problems.append(f"{path}: the password must come from the environment")
    return problems


def check_all(root: Path = ROOT) -> list[str]:
    problems = []
    for path in sorted((root / ".github/workflows").glob("*.yml")):
        problems += check_workflow(str(path.relative_to(root)), path.read_text())
    ci = root / ".github/workflows/ci.yml"
    problems += check_concurrency(str(ci.relative_to(root)), ci.read_text())
    for path in sorted((root / ".github/actions").rglob("action.yml")):
        problems += check_action(str(path.relative_to(root)), path.read_text())
    for path in sorted((root / "docker").glob("*.Dockerfile")):
        problems += check_dockerfile(str(path.relative_to(root)), path.read_text())
    problems += check_compose("compose.yaml", (root / "compose.yaml").read_text(), test_stack=False)
    problems += check_compose(
        "compose.test.yaml", (root / "compose.test.yaml").read_text(), test_stack=True
    )
    return problems


if __name__ == "__main__":
    found = check_all()
    print("\n".join(found) if found else "CI and Docker policy: all rules pass")
    sys.exit(1 if found else 0)
