"""The self-test has to pass on the real sanitizer, and fail when the sanitizer or its output is bad."""

import shutil
import zipfile
from pathlib import Path

import pytest
import yaml

from testforge_ai import sanitizer_self_test as self_test
from testforge_ai.cli import main

WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/sanitizer-self-test.yml"


def test_the_real_sanitizer_passes(tmp_path: Path) -> None:
    result = self_test.run_self_test(tmp_path)
    assert result["problems"] == []
    assert result["sanitizer"]["traces_kept"] == 1
    assert len(result["sanitizer"]["traces_dropped"]) == 1


def test_the_raw_run_really_holds_every_secret(tmp_path: Path) -> None:
    self_test.build_run(tmp_path / "raw")
    raw = b"\n".join(self_test._contents(tmp_path / "raw").values())
    for secret in self_test.SECRETS:
        assert secret.encode() in raw


def test_a_sanitizer_that_copies_traces_unchanged_is_caught(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def copy_unchanged(source: Path, target: Path) -> tuple[bool, int]:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        return True, 0

    monkeypatch.setattr("testforge_ai.sanitize.sanitize_trace", copy_unchanged)
    problems = self_test.run_self_test(tmp_path)["problems"]
    assert any("Dummy secret" in item for item in problems)
    assert any("could not be cleaned" in item for item in problems)


def test_a_sanitizer_that_removes_everything_is_caught(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("testforge_ai.sanitize.sanitize_trace", lambda source, target: (False, 0))
    problems = self_test.run_self_test(tmp_path)["problems"]
    assert any("could be cleaned was dropped" in item for item in problems)


@pytest.fixture
def public(tmp_path: Path) -> Path:
    assert self_test.run_self_test(tmp_path)["problems"] == []
    return tmp_path / "public"


def test_a_published_html_report_is_caught(public: Path) -> None:
    (public / "html").mkdir()
    assert any("HTML report" in item for item in self_test.verify_public_copy(public))


def test_a_secret_added_to_any_file_is_caught_without_printing_it(public: Path) -> None:
    (public / "extra.txt").write_text(self_test.DUMMY_PASSWORD)
    problems = self_test.verify_public_copy(public)
    assert any("extra.txt" in item for item in problems)
    assert self_test.DUMMY_PASSWORD not in " ".join(problems)


def test_lost_evidence_is_caught(public: Path) -> None:
    (public / "test-results" / self_test.SAFE_CASE / "test-failed-1.png").unlink()
    (public / "junit.xml").unlink()
    problems = self_test.verify_public_copy(public)
    assert any("screenshot" in item for item in problems)
    assert any("junit.xml" in item for item in problems)


def test_evidence_lost_from_a_trace_is_caught(public: Path) -> None:
    trace = public / "test-results" / self_test.SAFE_CASE / "trace.zip"
    with zipfile.ZipFile(trace, "w") as archive:
        archive.writestr("0-trace.trace", "{}")
    assert any("Evidence was lost" in item for item in self_test.verify_public_copy(public))


def test_a_missing_upload_is_caught(tmp_path: Path) -> None:
    assert self_test.verify_public_copy(tmp_path / "nope")


def test_the_command_passes_and_fails_with_its_exit_code(tmp_path: Path, capsys) -> None:
    assert main(["sanitize-self-test", "--workdir", str(tmp_path / "w")]) == 0
    public = tmp_path / "w" / "public"
    assert main(["sanitize-self-test", "--verify-only", str(public)]) == 0
    (public / "extra.txt").write_text(self_test.DUMMY_COOKIE)
    assert main(["sanitize-self-test", "--verify-only", str(public)]) == 1
    assert self_test.DUMMY_COOKIE not in capsys.readouterr().out


def test_the_workflow_runs_only_by_hand_and_uploads_only_the_public_copy() -> None:
    workflow = yaml.safe_load(WORKFLOW.read_text())
    assert list(workflow[True]) == ["workflow_dispatch"]
    assert workflow["permissions"] == {"contents": "read"}
    uploads = [
        step["with"]["path"]
        for job in workflow["jobs"].values()
        for step in job["steps"]
        if "upload-artifact" in step.get("uses", "")
    ]
    assert uploads == ["reports/sanitizer-self-test/public"]
