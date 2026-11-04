from datetime import timedelta

from sqlalchemy import select, update

from app.deps import COOKIE_NAME
from app.models import AuditLog, UserSession, utc_now
from app.security import hash_token
from tests.conftest import API, PASSWORD, assert_error


def test_login_sets_secure_session_cookie_and_returns_profile(anon, world):
    response = anon.post(
        f"{API}/auth/login", json={"email": world.manager.email, "password": PASSWORD}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["email"] == world.manager.email
    assert body["role"] == "MANAGER"
    assert "orders:write" in body["permissions"]
    assert "password_hash" not in body
    cookie = response.headers["set-cookie"].lower()
    assert "httponly" in cookie
    assert "samesite=lax" in cookie
    assert "path=/" in cookie


def test_session_token_is_stored_only_as_a_hash(anon, world, db):
    anon.post(f"{API}/auth/login", json={"email": world.admin.email, "password": PASSWORD})
    token = anon.cookies[COOKIE_NAME]
    hashes = db.scalars(select(UserSession.token_hash)).all()
    assert hashes == [hash_token(token)]
    assert token not in hashes


def test_email_login_is_case_insensitive(anon, world):
    response = anon.post(
        f"{API}/auth/login", json={"email": world.admin.email.upper(), "password": PASSWORD}
    )
    assert response.status_code == 200


def test_wrong_password_and_unknown_email_are_indistinguishable(anon, world):
    wrong = anon.post(f"{API}/auth/login", json={"email": world.admin.email, "password": "nope"})
    unknown = anon.post(
        f"{API}/auth/login", json={"email": "ghost@test.example", "password": "nope"}
    )
    first = assert_error(wrong, 401, "INVALID_CREDENTIALS")
    second = assert_error(unknown, 401, "INVALID_CREDENTIALS")
    assert first["message"] == second["message"]
    assert COOKIE_NAME not in anon.cookies


def test_failed_login_is_audited(anon, world, db):
    anon.post(f"{API}/auth/login", json={"email": world.admin.email, "password": "nope"})
    entry = db.scalar(select(AuditLog).where(AuditLog.action == "auth.login_failed"))
    assert entry is not None
    assert entry.entity_id == world.admin.email


def test_inactive_user_cannot_log_in(admin, anon, world):
    assert (
        admin.patch(f"{API}/users/{world.viewer.id}", json={"is_active": False}).status_code == 200
    )
    response = anon.post(
        f"{API}/auth/login", json={"email": world.viewer.email, "password": PASSWORD}
    )
    assert_error(response, 401, "INVALID_CREDENTIALS")


def test_me_requires_authentication(anon):
    assert_error(anon.get(f"{API}/auth/me"), 401, "NOT_AUTHENTICATED")


def test_me_rejects_forged_token(anon):
    anon.cookies.set(COOKIE_NAME, "forged-token")
    assert_error(anon.get(f"{API}/auth/me"), 401, "INVALID_SESSION")


def test_logout_invalidates_the_session_server_side(manager):
    token = manager.cookies[COOKIE_NAME]
    assert manager.get(f"{API}/auth/me").status_code == 200
    assert manager.post(f"{API}/auth/logout").status_code == 204
    # Replaying the old cookie must fail: logout is more than deleting it from the browser.
    manager.cookies.set(COOKIE_NAME, token)
    assert_error(manager.get(f"{API}/auth/me"), 401, "INVALID_SESSION")


def test_logout_without_session_is_idempotent(anon):
    assert anon.post(f"{API}/auth/logout").status_code == 204


def test_expired_session_is_rejected(manager, db):
    db.execute(update(UserSession).values(expires_at=utc_now() - timedelta(seconds=1)))
    db.commit()
    assert_error(manager.get(f"{API}/auth/me"), 401, "SESSION_EXPIRED")


def test_login_removes_this_users_expired_sessions(anon, manager, world, db):
    db.execute(update(UserSession).values(expires_at=utc_now() - timedelta(hours=1)))
    db.commit()
    anon.post(f"{API}/auth/login", json={"email": world.manager.email, "password": PASSWORD})
    db.expire_all()
    remaining = db.scalars(select(UserSession)).all()
    assert len(remaining) == 1
    assert remaining[0].expires_at > utc_now()


def test_cross_site_write_is_rejected(manager):
    response = manager.post(f"{API}/auth/logout", headers={"Origin": "https://evil.example"})
    assert_error(response, 403, "ORIGIN_NOT_ALLOWED")
    assert manager.get(f"{API}/auth/me").status_code == 200


def test_allowed_origin_may_write(manager):
    response = manager.post(f"{API}/auth/logout", headers={"Origin": "http://localhost:5173"})
    assert response.status_code == 204
