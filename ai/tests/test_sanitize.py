import base64
import json
import zipfile
from pathlib import Path

import pytest

from testforge_ai.sanitize import REDACTED, sanitize_run, sanitize_trace

PASSWORD = "Sup3r-Secret-Value"
COOKIE = "c00kieValue1234567890"
TYPED = "Typed-Secret-Value-9"
KEY = "sk-abcdefghijklmnopqrstuvwx"


def make_trace(path: Path, extra: dict[str, bytes] | None = None) -> None:
    trace = [
        {
            "type": "before",
            "callId": "1",
            "class": "APIRequestContext",
            "method": "fetch",
            "params": {"jsonData": json.dumps({"email": "a@b.example", "password": PASSWORD})},
        },
        {
            "type": "before",
            "callId": "2",
            "class": "Frame",
            "method": "fill",
            "params": {"selector": 'internal:label="Password"', "value": TYPED},
        },
        {
            "type": "before",
            "callId": "3",
            "class": "Frame",
            "method": "fill",
            "params": {"selector": 'internal:label="Search"', "value": "drill"},
        },
        {
            "type": "frame-snapshot",
            "snapshot": {"html": ["INPUT", {"type": "password", "__playwright_value_": TYPED}]},
        },
        {"type": "log", "callId": "1", "message": f"sent testforge_session={COOKIE}"},
        {"type": "log", "callId": "1", "message": f"key {KEY}"},
    ]
    network = [
        {
            "type": "resource-snapshot",
            "snapshot": {
                "request": {
                    "method": "POST",
                    "url": "http://localhost/api/v1/auth/login",
                    "cookies": [{"name": "testforge_session", "value": COOKIE}],
                    "headers": [
                        {"name": "Cookie", "value": f"testforge_session={COOKIE}"},
                        {"name": "Accept", "value": "application/json"},
                    ],
                    "postData": {"text": json.dumps({"password": PASSWORD})},
                },
                "response": {
                    "status": 200,
                    "headers": [
                        {"name": "set-cookie", "value": f"testforge_session={COOKIE}; Path=/"}
                    ],
                    "cookies": [{"name": "testforge_session", "value": COOKIE}],
                },
            },
        }
    ]
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("0-trace.trace", "\n".join(json.dumps(item) for item in trace) + "\n")
        archive.writestr("0-trace.network", "\n".join(json.dumps(item) for item in network) + "\n")
        archive.writestr("resources/body.json", json.dumps({"password": PASSWORD}))
        archive.writestr("resources/page.html", f"<p>{COOKIE}</p>")
        archive.writestr("resources/frame.jpeg", b"\xff\xd8\xff binary")
        for name, body in (extra or {}).items():
            archive.writestr(name, body)


def all_bytes(path: Path) -> bytes:
    with zipfile.ZipFile(path) as archive:
        return b"\n".join(archive.read(name) for name in archive.namelist())


class TestTrace:
    def test_every_secret_is_removed(self, tmp_path: Path) -> None:
        source, target = tmp_path / "in.zip", tmp_path / "out.zip"
        make_trace(source)
        kept, count = sanitize_trace(source, target)
        assert kept
        assert count >= 3
        data = all_bytes(target)
        for secret in (PASSWORD, COOKIE, TYPED, KEY):
            assert secret.encode() not in data, secret
        assert REDACTED.encode() in data

    def test_the_trace_stays_usable(self, tmp_path: Path) -> None:
        source, target = tmp_path / "in.zip", tmp_path / "out.zip"
        make_trace(source)
        sanitize_trace(source, target)
        with zipfile.ZipFile(source) as before, zipfile.ZipFile(target) as after:
            assert before.namelist() == after.namelist()
            lines = after.read("0-trace.trace").decode().splitlines()
            events = [json.loads(line) for line in lines]
            assert after.read("resources/frame.jpeg") == before.read("resources/frame.jpeg")
        assert [event["type"] for event in events[:3]] == ["before"] * 3
        # What is not sensitive is left alone, so the failure can still be understood.
        assert events[2]["params"]["value"] == "drill"
        network = json.loads(zipfile.ZipFile(target).read("0-trace.network"))
        headers = {
            item["name"]: item["value"] for item in network["snapshot"]["request"]["headers"]
        }
        assert headers["Accept"] == "application/json"
        assert headers["Cookie"] == REDACTED

    def test_the_source_is_not_changed(self, tmp_path: Path) -> None:
        source, target = tmp_path / "in.zip", tmp_path / "out.zip"
        make_trace(source)
        before = source.read_bytes()
        sanitize_trace(source, target)
        assert source.read_bytes() == before

    def test_a_trace_that_cannot_be_cleaned_is_dropped(self, tmp_path: Path) -> None:
        source, target = tmp_path / "in.zip", tmp_path / "out.zip"
        # A compressed member the text pass cannot read still holds the cookie pattern.
        make_trace(source, {"resources/blob.bin": b"\x00testforge_session=abcdefghij123456\x00"})
        kept, _ = sanitize_trace(source, target)
        assert not kept
        assert not target.exists()

    def test_a_cookie_only_seen_elsewhere_is_replaced_in_binary_members(
        self, tmp_path: Path
    ) -> None:
        source, target = tmp_path / "in.zip", tmp_path / "out.zip"
        make_trace(source, {"resources/blob.bin": b"\x00" + COOKIE.encode() + b"\x00"})
        kept, _ = sanitize_trace(source, target)
        assert kept
        assert COOKIE.encode() not in all_bytes(target)


def trace_with(tmp_path: Path, event: dict) -> bytes:
    source, target = tmp_path / "one.zip", tmp_path / "clean.zip"
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("0-trace.trace", json.dumps(event) + "\n")
    kept, _ = sanitize_trace(source, target)
    assert kept
    return all_bytes(target)


class TestSourceFilesInTraces:
    """Real traces bundle test source, which is how seed passwords first got through."""

    def test_passwords_in_bundled_source_are_removed(self, tmp_path: Path) -> None:
        source, target = tmp_path / "in.zip", tmp_path / "out.zip"
        code = b'manager: { email: "m@x.example", password: "Manager!Forge2026" },\n'
        code += b"const password = `E2E-Passw0rd-${this.namespace}`;\n"
        make_trace(source, {"src/abc.ts": code})
        kept, _ = sanitize_trace(source, target)
        assert kept
        data = all_bytes(target)
        assert b"Forge2026" not in data
        assert b"E2E-Passw0rd" not in data

    def test_a_seed_password_in_an_unreadable_member_drops_the_trace(self, tmp_path: Path) -> None:
        source, target = tmp_path / "in.zip", tmp_path / "out.zip"
        make_trace(source, {"resources/blob.bin": b"\x00Admin!Forge2026\x00"})
        kept, _ = sanitize_trace(source, target)
        assert not kept


class TestEachRuleOnItsOwn:
    """One value in one place each, so that no rule is covered by another finding the same value."""

    def test_a_value_filled_into_a_password_field(self, tmp_path: Path) -> None:
        event = {"params": {"selector": 'internal:label="Password"', "value": "Only-In-Fill-1"}}
        assert b"Only-In-Fill-1" not in trace_with(tmp_path, event)

    def test_a_value_in_a_password_input_in_a_snapshot(self, tmp_path: Path) -> None:
        event = {"html": ["INPUT", {"type": "password", "__playwright_value_": "Only-In-Dom-1"}]}
        assert b"Only-In-Dom-1" not in trace_with(tmp_path, event)

    def test_a_cookie_array(self, tmp_path: Path) -> None:
        event = {"cookies": [{"name": "other", "value": "Only-In-Cookie-1"}]}
        assert b"Only-In-Cookie-1" not in trace_with(tmp_path, event)

    def test_a_sensitive_header(self, tmp_path: Path) -> None:
        event = {"headers": [{"name": "Authorization", "value": "Only-In-Header-1"}]}
        assert b"Only-In-Header-1" not in trace_with(tmp_path, event)

    def test_a_password_inside_a_json_request_body(self, tmp_path: Path) -> None:
        event = {"params": {"jsonData": json.dumps({"password": "Only-In-Body-1"})}}
        assert b"Only-In-Body-1" not in trace_with(tmp_path, event)

    def test_an_ordinary_fill_is_kept(self, tmp_path: Path) -> None:
        event = {"params": {"selector": 'internal:label="Search"', "value": "Cordless-Drill"}}
        assert b"Cordless-Drill" in trace_with(tmp_path, event)


def make_run(run: Path) -> None:
    results = run / "test-results" / "case"
    results.mkdir(parents=True)
    make_trace(results / "trace.zip")
    (results / "test-failed-1.png").write_bytes(b"\x89PNG")
    (results / "error-context.md").write_text(f'```yaml\n"password": "{PASSWORD}"\n```\n')
    html = run / "html" / "data"
    html.mkdir(parents=True)
    make_trace(html / "raw.zip")
    (run / "junit.xml").write_text(f"<x>cookie: testforge_session={COOKIE}</x>")
    diagnostics = json.dumps({"errors": [f"cookie: {COOKIE}"]})
    report = {
        "stats": {"expected": 0, "unexpected": 1, "flaky": 0, "skipped": 0},
        "errors": [f"at /Users/somebody/project: Bearer {COOKIE}"],
        "attachments": [
            {
                "name": "diagnostics",
                "contentType": "application/json",
                "body": base64.b64encode(diagnostics.encode()).decode(),
            }
        ],
    }
    (run / "playwright.json").write_text(json.dumps(report))


class TestRun:
    def test_public_copy_has_no_secrets_or_html_report(self, tmp_path: Path) -> None:
        run, out = tmp_path / "run", tmp_path / "out"
        make_run(run)
        summary = sanitize_run(run, out)
        assert summary["traces_kept"] == 1
        assert summary["traces_dropped"] == []
        assert not (out / "html").exists()
        assert (out / "test-results/case/test-failed-1.png").exists()
        assert (out / "sanitize-report.json").exists()
        for path in out.rglob("*"):
            if not path.is_file():
                continue
            data = all_bytes(path) if path.suffix == ".zip" else path.read_bytes()
            for secret in (PASSWORD, COOKIE, TYPED):
                assert secret.encode() not in data, path
        assert b"/Users/somebody" not in (out / "playwright.json").read_bytes()

    def test_inline_diagnostics_are_redacted(self, tmp_path: Path) -> None:
        run, out = tmp_path / "run", tmp_path / "out"
        make_run(run)
        sanitize_run(run, out)
        attachment = json.loads((out / "playwright.json").read_text())["attachments"][0]
        assert COOKIE not in base64.b64decode(attachment["body"]).decode()

    def test_a_dropped_trace_is_reported(self, tmp_path: Path) -> None:
        run, out = tmp_path / "run", tmp_path / "out"
        make_run(run)
        (run / "test-results/case/trace.zip").write_bytes(b"not a zip")
        summary = sanitize_run(run, out)
        assert summary["traces_dropped"] == ["test-results/case/trace.zip"]
        assert not (out / "test-results/case/trace.zip").exists()

    def test_refuses_to_write_inside_the_run(self, tmp_path: Path) -> None:
        run = tmp_path / "run"
        make_run(run)
        with pytest.raises(ValueError, match="outside"):
            sanitize_run(run, run / "public")

    def test_refuses_a_missing_run(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="No such run"):
            sanitize_run(tmp_path / "nope", tmp_path / "out")
