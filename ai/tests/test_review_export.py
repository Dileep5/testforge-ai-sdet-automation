import ast
import json
import subprocess
from pathlib import Path

import pytest

from testforge_ai.generation.exporter import (
    SENTINEL,
    SKELETON_SUFFIX,
    ExportRefused,
    export_skeleton,
    render_skeleton,
)
from testforge_ai.generation.models import ReviewBundle
from testforge_ai.generation.pipeline import build_bundle, load_story
from testforge_ai.generation.review import ReviewError, approve, load_bundle, reject, save_bundle

AI_DIR = Path(__file__).resolve().parents[1]
REPO = AI_DIR.parent
STORY = AI_DIR / "stories" / "US-102.json"


@pytest.fixture
def bundle() -> ReviewBundle:
    text = (AI_DIR / "fixtures" / "generation" / "good.json").read_text()
    return build_bundle(load_story(STORY), text, "fixture")


def approve_all(bundle: ReviewBundle) -> None:
    for case in bundle.cases:
        approve(bundle, case.id, "Sam Reviewer")


class TestReview:
    def test_unapproved_output_is_refused(self, bundle: ReviewBundle) -> None:
        with pytest.raises(ExportRefused, match="pending, not approved"):
            render_skeleton(bundle)

    def test_one_pending_case_blocks_the_export(self, bundle: ReviewBundle) -> None:
        approve(bundle, bundle.cases[0].id, "Sam Reviewer")
        with pytest.raises(ExportRefused, match=f"{bundle.cases[1].id} is pending"):
            render_skeleton(bundle)

    def test_rejected_cases_are_left_out_of_the_export(self, bundle: ReviewBundle) -> None:
        approve_all(bundle)
        reject(bundle, bundle.cases[0].id, "Sam Reviewer", "Not useful")
        output = render_skeleton(bundle)
        assert bundle.cases[0].id not in output
        assert bundle.cases[1].id in output

    def test_nothing_approved_means_nothing_exported(self, bundle: ReviewBundle) -> None:
        for case in bundle.cases:
            reject(bundle, case.id, "Sam Reviewer", "No")
        with pytest.raises(ExportRefused, match="No approved cases"):
            render_skeleton(bundle)

    def test_rejection_needs_a_reason(self, bundle: ReviewBundle) -> None:
        with pytest.raises(ReviewError, match="reason"):
            reject(bundle, bundle.cases[0].id, "Sam Reviewer", "  ")

    @pytest.mark.parametrize("reviewer", ["", "  ", "llm", "AUTO", "CI", "openai"])
    def test_a_machine_cannot_approve(self, bundle: ReviewBundle, reviewer: str) -> None:
        with pytest.raises(ReviewError, match="person"):
            approve(bundle, bundle.cases[0].id, reviewer)

    def test_unknown_case_id(self, bundle: ReviewBundle) -> None:
        with pytest.raises(ReviewError, match="No case"):
            approve(bundle, "TC-US-102-999", "Sam Reviewer")

    def test_editing_an_approved_case_voids_the_approval(
        self, bundle: ReviewBundle, tmp_path: Path
    ) -> None:
        approve_all(bundle)
        path = tmp_path / "bundle.json"
        save_bundle(bundle, path)
        data = json.loads(path.read_text())
        data["cases"][0]["case"]["steps"] = ["Do something else entirely"]
        path.write_text(json.dumps(data))
        with pytest.raises(ExportRefused, match="changed after it was approved"):
            render_skeleton(load_bundle(path))

    def test_editing_the_story_voids_every_approval(self, bundle: ReviewBundle) -> None:
        approve_all(bundle)
        bundle.story.title = "Something else"
        with pytest.raises(ExportRefused, match="story changed"):
            render_skeleton(bundle)

    def test_hand_written_status_without_a_decision_is_refused(
        self, bundle: ReviewBundle, tmp_path: Path
    ) -> None:
        path = tmp_path / "bundle.json"
        save_bundle(bundle, path)
        data = json.loads(path.read_text())
        for case in data["cases"]:
            case["status"] = "approved"
        path.write_text(json.dumps(data))
        with pytest.raises(ExportRefused, match="not approved"):
            render_skeleton(load_bundle(path))

    def test_flags_must_be_acknowledged_with_a_note(self) -> None:
        text = (AI_DIR / "fixtures" / "generation" / "unsupported_assumptions.json").read_text()
        bundle = build_bundle(load_story(STORY), text, "fixture")
        case_id = bundle.cases[0].id
        with pytest.raises(ReviewError, match="flags to acknowledge"):
            approve(bundle, case_id, "Sam Reviewer")
        with pytest.raises(ReviewError, match="needs a note"):
            approve(bundle, case_id, "Sam Reviewer", acknowledge_flags=True)
        approve(bundle, case_id, "Sam Reviewer", "Checked with product", acknowledge_flags=True)
        assert bundle.cases[0].status.value == "approved"

    def test_save_and_load_keep_approval_valid(self, bundle: ReviewBundle, tmp_path: Path) -> None:
        approve_all(bundle)
        path = tmp_path / "bundle.json"
        save_bundle(bundle, path)
        assert render_skeleton(load_bundle(path)) == render_skeleton(bundle)


HOSTILE = [
    '"); require("child_process").execSync("touch /tmp/pwned"); ("',
    "*/ process.exit(1); /*",
    "`${process.exit(1)}`",
    '\\"; process.exit(1); //',
    "line process.exit(1)",
    "\nprocess.exit(1)\n",
]

AST_CHECK = """
const ts = require(process.argv[2]);
const source = require("fs").readFileSync(process.argv[3], "utf8");
const file = ts.createSourceFile("s.ts", source, ts.ScriptTarget.ES2022, true);
if (file.parseDiagnostics.length) { console.log("PARSE_ERROR"); process.exit(0); }
const calls = [];
const visit = (node) => {
  if (ts.isCallExpression(node)) calls.push(node.expression.getText(file));
  if (ts.isNewExpression(node)) calls.push("new " + node.expression.getText(file));
  ts.forEachChild(node, visit);
};
visit(file);
console.log(JSON.stringify({ statements: file.statements.map((s) => ts.SyntaxKind[s.kind]), calls }));
"""


def parse(path: Path, tmp_path: Path) -> dict[str, list[str]]:
    script = tmp_path / "check.cjs"
    script.write_text(AST_CHECK)
    typescript = REPO / "node_modules" / "typescript"
    result = subprocess.run(
        ["node", str(script), str(typescript), str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)


class TestSkeleton:
    def test_skeleton_cannot_run_or_pass(self, bundle: ReviewBundle, tmp_path: Path) -> None:
        approve_all(bundle)
        path = export_skeleton(bundle, tmp_path)
        assert path.name == f"US-102{SKELETON_SUFFIX}"
        text = path.read_text()
        assert SENTINEL in text
        assert text.count("test.fixme(") == len(bundle.cases)
        assert text.count("throw new Error") == len(bundle.cases)
        tree = parse(path, tmp_path)
        assert set(tree["calls"]) == {"test.fixme", "new Error"}

    def test_keeps_traceability(self, bundle: ReviewBundle) -> None:
        approve_all(bundle)
        text = render_skeleton(bundle)
        assert "US-102/AC-1" in text
        assert "Sam Reviewer" in text

    @pytest.mark.parametrize("payload", HOSTILE)
    @pytest.mark.parametrize("field", ["title", "steps", "expected_results"])
    def test_hostile_text_stays_inside_strings(
        self, bundle: ReviewBundle, tmp_path: Path, payload: str, field: str
    ) -> None:
        case = bundle.cases[0]
        case.case = case.case.model_copy(update={field: payload if field == "title" else [payload]})
        approve_all(bundle)
        path = export_skeleton(bundle, tmp_path)
        tree = parse(path, tmp_path)
        assert tree["statements"] == ["ImportDeclaration"] + ["ExpressionStatement"] * len(
            bundle.cases
        )
        assert set(tree["calls"]) == {"test.fixme", "new Error"}

    def test_no_skeleton_has_been_added_to_a_test_suite(self) -> None:
        for folder in ("tests", "framework"):
            for path in (REPO / folder).rglob("*"):
                if path.is_file():
                    assert SENTINEL not in path.read_text(errors="ignore"), path
                    assert not path.name.endswith(SKELETON_SUFFIX), path


class TestNothingExecutes:
    def test_the_package_cannot_run_generated_content(self) -> None:
        """Parse the source: no eval, exec, subprocess, os.system or dynamic import anywhere."""
        banned_names = {"eval", "exec", "compile", "__import__"}
        banned_attributes = {"system", "popen", "eval", "exec"}
        banned_imports = {"subprocess", "importlib.util", "pty", "runpy"}
        for path in (AI_DIR / "testforge_ai").rglob("*.py"):
            tree = ast.parse(path.read_text())
            for node in ast.walk(tree):
                if isinstance(node, ast.Call):
                    if isinstance(node.func, ast.Name):
                        assert node.func.id not in banned_names, f"{path}:{node.lineno}"
                    if isinstance(node.func, ast.Attribute):
                        assert node.func.attr not in banned_attributes, f"{path}:{node.lineno}"
                if isinstance(node, ast.Import):
                    assert not {alias.name for alias in node.names} & banned_imports, path
                if isinstance(node, ast.ImportFrom):
                    assert node.module not in banned_imports, path
