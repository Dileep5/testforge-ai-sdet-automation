import json
from pathlib import Path

import pytest

from testforge_ai.cli import main

AI_DIR = Path(__file__).resolve().parents[1]
STORY = str(AI_DIR / "stories" / "US-102.json")
GOOD = str(AI_DIR / "fixtures" / "generation" / "good.json")


def test_whole_workflow_from_story_to_skeleton(tmp_path: Path, capsys) -> None:
    bundle = tmp_path / "bundle.json"
    assert main(["generate", "--story", STORY, "--out", str(bundle)]) == 0
    assert main(["export", "--bundle", str(bundle), "--out", str(tmp_path)]) == 2
    assert "not approved" in capsys.readouterr().err

    cases = [case["id"] for case in json.loads(bundle.read_text())["cases"]]
    args = ["review", "approve", "--bundle", str(bundle), "--reviewer", "Sam Reviewer"]
    for case in cases:
        args += ["--case", case]
    assert main(args) == 0
    assert main(["export", "--bundle", str(bundle), "--out", str(tmp_path)]) == 0
    assert (tmp_path / "US-102.skeleton.ts.txt").exists()


def test_fixture_provider(tmp_path: Path, capsys) -> None:
    out = tmp_path / "b.json"
    assert (
        main(
            [
                "generate",
                "--story",
                STORY,
                "--provider",
                "fixture",
                "--fixture",
                GOOD,
                "--out",
                str(out),
            ]
        )
        == 0
    )
    assert json.loads(capsys.readouterr().out)["generator"] == "fixture"


def test_review_list_shows_flags(tmp_path: Path, capsys) -> None:
    out = tmp_path / "b.json"
    fixture = str(AI_DIR / "fixtures" / "generation" / "unsupported_assumptions.json")
    main(
        [
            "generate",
            "--story",
            STORY,
            "--provider",
            "fixture",
            "--fixture",
            fixture,
            "--out",
            str(out),
        ]
    )
    capsys.readouterr()
    assert main(["review", "list", "--bundle", str(out)]) == 0
    listing = json.loads(capsys.readouterr().out)
    assert any("unsupported_number" in flag for flag in listing[0]["flags"])


def test_invalid_output_exits_without_a_bundle(tmp_path: Path, capsys) -> None:
    out = tmp_path / "b.json"
    fixture = str(AI_DIR / "fixtures" / "generation" / "invalid_json.txt")
    assert (
        main(
            [
                "generate",
                "--story",
                STORY,
                "--provider",
                "fixture",
                "--fixture",
                fixture,
                "--out",
                str(out),
            ]
        )
        == 2
    )
    assert "invalid_json" in capsys.readouterr().err
    assert not out.exists()


def test_live_mode_is_refused_without_opt_in(capsys, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-fakefakefakefake")
    assert main(["chat", "Hello?", "--provider", "openai", "--model", "m"]) == 2
    error = capsys.readouterr().err
    assert "TESTFORGE_ALLOW_LIVE_LLM" in error
    assert "sk-fake" not in error


def test_chat_offline(capsys) -> None:
    assert main(["chat", "How long do refunds take?"]) == 0
    assert json.loads(capsys.readouterr().out)["status"] == "answered"


def test_eval_writes_a_report(tmp_path: Path, capsys) -> None:
    out = tmp_path / "r.json"
    assert main(["eval", "--split", "dev", "--repeats", "1", "--out", str(out)]) == 0
    assert json.loads(out.read_text())["rows"] == 74


def test_triage_from_real_junit(tmp_path: Path, capsys) -> None:
    junit = AI_DIR / "fixtures" / "triage" / "corpus-junit.xml"
    assert main(["triage", "--junit", str(junit), "--out", str(tmp_path / "t.json")]) == 0
    result = json.loads((tmp_path / "t.json").read_text())
    assert result["failures"] == 71
    assert all(item["automatic_changes_allowed"] is False for item in result["results"])
