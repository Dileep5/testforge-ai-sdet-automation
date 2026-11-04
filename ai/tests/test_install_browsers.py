"""The browser install script, run for real with stand-ins for sudo, timeout and Playwright."""

import os
import stat
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "install-browsers.sh"


def stub(folder: Path, name: str, body: str) -> None:
    path = folder / name
    path.write_text(f"#!/usr/bin/env bash\n{body}\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


@pytest.fixture
def run(tmp_path: Path):
    stubs = tmp_path / "bin"
    stubs.mkdir()
    log = tmp_path / "calls.log"
    archives = tmp_path / "archives"
    conf = tmp_path / "apt.conf"
    stub(stubs, "sudo", f'echo "sudo $*" >> "{log}"\nif [[ "$1" == chown ]]; then exit 0; fi\n"$@"')
    stub(stubs, "npx", f'echo "npx $*" >> "{log}"\ntouch "{archives}/a.deb" "{archives}/b.deb"')

    def execute(timeout_body: str = '"${@:2}"', *browsers: str) -> subprocess.CompletedProcess:
        stub(stubs, "timeout", f'echo "timeout $1" >> "{log}"\n{timeout_body}')
        env = os.environ | {
            "PATH": f"{stubs}{os.pathsep}{os.environ['PATH']}",
            "APT_ARCHIVES_DIR": str(archives),
            "APT_CONF_FILE": str(conf),
        }
        return subprocess.run(
            ["bash", str(SCRIPT), *(browsers or ("webkit",))],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

    execute.log = log
    execute.conf = conf
    execute.archives = archives
    return execute


def test_a_normal_install_is_bounded_and_keeps_its_packages(run) -> None:
    result = run('"${@:2}"', "chromium", "webkit")
    assert result.returncode == 0
    calls = run.log.read_text()
    assert "timeout 15m" in calls
    assert "npx playwright install-deps\n" in calls
    assert "npx playwright install chromium webkit\n" in calls
    assert "Package cache: 0 packages before" in result.stdout
    assert "Package cache: 2 packages after" in result.stdout
    assert "::error" not in result.stdout


def test_apt_is_pointed_at_the_cached_folder(run) -> None:
    run()
    config = run.conf.read_text()
    assert f'Dir::Cache::Archives "{run.archives}/";' in config
    assert 'Acquire::Retries "3";' in config


def test_the_cache_step_can_read_what_root_wrote(run) -> None:
    run()
    assert "sudo chown -R" in run.log.read_text()
    assert not (run.archives / "partial").exists()


def test_a_timeout_fails_with_a_message_that_names_the_cause(run) -> None:
    result = run("exit 124")
    assert result.returncode == 124
    assert "::error title=Browser install timed out::" in result.stdout
    assert "15 minutes" in result.stdout
    assert "not a test or application failure" in result.stdout


def test_any_other_failure_is_reported_and_not_hidden(run) -> None:
    result = run("exit 7")
    assert result.returncode == 7
    assert "::error title=Browser install failed::" in result.stdout
    assert "exited with 7" in result.stdout


def test_a_failed_package_install_stops_before_downloading_browsers(run, tmp_path: Path) -> None:
    stub(tmp_path / "bin", "npx", f'echo "npx $*" >> "{run.log}"\n[[ "$2" != install-deps ]]')
    result = run()
    assert result.returncode != 0
    assert "npx playwright install webkit" not in run.log.read_text()
    assert "::error" in result.stdout


def test_the_limit_can_be_changed(run, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BROWSER_INSTALL_LIMIT_MINUTES", "9")
    run()
    assert "timeout 9m" in run.log.read_text()


def test_ci_cannot_install_browsers_without_the_limit() -> None:
    action = (ROOT / ".github/actions/setup-test-env/action.yml").read_text()
    assert "scripts/install-browsers.sh" in action
    assert "playwright install" not in action


def test_one_package_cache_serves_every_browser_job() -> None:
    action = (ROOT / ".github/actions/setup-test-env/action.yml").read_text()
    # The runner's own variable: GitHub's env context does not hold it in a composite action.
    assert "env.ImageOS" not in action
    assert 'prefix="apt-${ImageOS}-"' in action
    restore = action[action.index("Restore system packages") :]
    assert "inputs.browsers }}-" not in restore
    assert "hashFiles" not in restore
