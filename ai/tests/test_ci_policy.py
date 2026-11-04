"""The policy checker has to pass on the real files and catch each kind of bad change."""

import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "check_ci_policy", ROOT / "scripts/check_ci_policy.py"
)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

SHA = "a" * 40
GOOD = f"""
on: pull_request
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    env:
      E2E_RETRIES: "0"
    steps:
      - uses: actions/checkout@{SHA}
      - run: npm test
"""


def test_the_real_files_pass() -> None:
    assert policy.check_all() == []


def test_a_good_workflow_passes() -> None:
    assert policy.check_workflow("w", GOOD) == []


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (("permissions:\n  contents: read\n", ""), "no top-level permissions"),
        (("contents: read", "contents: write"), "write permission"),
        (("on: pull_request", "on: pull_request_target"), "pull_request_target"),
        (("npm test", "npm test || true"), "fail silently"),
        (("- run: npm test", "- continue-on-error: true\n        run: npm test"), "fail silently"),
        (("npm test", "echo ${{ secrets.TOKEN }}"), "repository secret"),
        (('E2E_RETRIES: "0"', 'E2E_RETRIES: "3"'), "retries are not 0"),
        (('E2E_RETRIES: "0"', 'TESTFORGE_ALLOW_LIVE_LLM: "1"'), "live model"),
        (('E2E_RETRIES: "0"', "OPENAI_API_KEY: x"), "live model"),
        ((f"checkout@{SHA}", "checkout@v4"), "not pinned"),
        (("    timeout-minutes: 5\n", ""), "no timeout"),
    ],
)
def test_a_bad_workflow_is_caught(change: tuple[str, str], message: str) -> None:
    assert GOOD.count(change[0]) >= 1
    problems = policy.check_workflow("w", GOOD.replace(*change))
    assert any(message in item for item in problems), problems


UPLOAD = (
    GOOD
    + f"""
      - uses: actions/upload-artifact@{SHA}
        with:
          path: PATH
          retention-days: 14
"""
)


@pytest.mark.parametrize("path", ["reports/runs/x", "reports/runs/x/html", "test-results"])
def test_raw_artifacts_cannot_be_uploaded(path: str) -> None:
    problems = policy.check_workflow("w", UPLOAD.replace("PATH", path))
    assert any("raw artifacts" in item for item in problems)


def test_sanitized_artifacts_can_be_uploaded() -> None:
    assert policy.check_workflow("w", UPLOAD.replace("PATH", "reports/sanitized/x")) == []


def test_an_upload_needs_a_retention_period() -> None:
    text = UPLOAD.replace("PATH", "reports/sanitized/x").replace(
        "          retention-days: 14\n", ""
    )
    assert any("retention" in item for item in policy.check_workflow("w", text))


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("FROM python:3.13\nUSER 1\n", "not pinned"),
        (f"FROM python:3@sha256:{'a' * 64}\n", "runs as root"),
        (f"FROM p@sha256:{'a' * 64}\nENV DB_PASSWORD=x\nUSER 1\n", "credential"),
        (f"FROM p@sha256:{'a' * 64}\nARG API_KEY=x\nUSER 1\n", "credential"),
    ],
)
def test_a_bad_dockerfile_is_caught(text: str, message: str) -> None:
    assert any(message in item for item in policy.check_dockerfile("d", text))


COMPOSE = (ROOT / "compose.yaml").read_text()
TEST_COMPOSE = (ROOT / "compose.test.yaml").read_text()


@pytest.mark.parametrize(
    ("before", "after", "message"),
    [
        (
            "${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in docker/.env}",
            "hunter2",
            "from the environment",
        ),
        ('"127.0.0.1:${WEB_PORT:-8080}:8080"', '"8080:8080"', "beyond this machine"),
        ("    healthcheck:\n      test:", "    labels:\n      test:", "no health check"),
        (
            "@sha256:839fbb5a4942a7758dd93e18b42ea5649807491a0545b5eeeb8f0b8bb11857a5",
            "",
            "not pinned",
        ),
    ],
)
def test_a_bad_compose_file_is_caught(before: str, after: str, message: str) -> None:
    assert before in COMPOSE
    problems = policy.check_compose("c", COMPOSE.replace(before, after, 1), test_stack=False)
    assert any(message in item for item in problems), problems


def test_the_test_stack_must_stay_isolated() -> None:
    named = TEST_COMPOSE.replace("POSTGRES_DB: testforge_e2e", "POSTGRES_DB: testforge")
    assert any(
        "named for E2E" in item for item in policy.check_compose("c", named, test_stack=True)
    )
    kept = TEST_COMPOSE.replace("    tmpfs:\n      - /var/lib/postgresql/data\n", "")
    assert any("not persist" in item for item in policy.check_compose("c", kept, test_stack=True))


CONCURRENCY = """
concurrency:
  group: ci-${{ github.event_name == 'pull_request' && github.ref || github.sha }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
"""


def test_good_concurrency_passes() -> None:
    assert policy.check_concurrency("w", CONCURRENCY) == []


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (("${{ github.event_name == 'pull_request' }}", "true"), "pull requests only"),
        (("|| github.sha", "|| github.ref"), "group of their own"),
    ],
)
def test_main_results_cannot_be_cancelled(change: tuple[str, str], message: str) -> None:
    problems = policy.check_concurrency("w", CONCURRENCY.replace(*change))
    assert any(message in item for item in problems), problems
