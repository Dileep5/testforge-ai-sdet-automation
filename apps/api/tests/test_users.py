from sqlalchemy import select

from app.models import AuditLog, User
from tests.conftest import API, PASSWORD, assert_error

NEW_USER = {
    "email": "new.user@test.example",
    "full_name": "New User",
    "password": "A-Long-Enough-Passw0rd",
    "role": "MANAGER",
}


def test_only_admin_can_list_users(admin, manager, viewer, anon):
    response = admin.get(f"{API}/users")
    assert response.status_code == 200
    assert {u["email"] for u in response.json()} >= {"admin@test.example", "viewer@test.example"}
    assert all("password_hash" not in u for u in response.json())
    assert_error(manager.get(f"{API}/users"), 403, "FORBIDDEN")
    assert_error(viewer.get(f"{API}/users"), 403, "FORBIDDEN")
    assert_error(anon.get(f"{API}/users"), 401, "NOT_AUTHENTICATED")


def test_roles_endpoint_describes_permissions(viewer):
    roles = {r["name"]: r["permissions"] for r in viewer.get(f"{API}/roles").json()}
    assert set(roles) == {"ADMIN", "MANAGER", "VIEWER"}
    assert "users:manage" in roles["ADMIN"]
    assert "users:manage" not in roles["MANAGER"]
    assert roles["VIEWER"] == []


def test_admin_creates_user_who_can_log_in(admin, anon, db):
    created = admin.post(f"{API}/users", json=NEW_USER)
    assert created.status_code == 201
    assert created.json()["role"] == "MANAGER"
    stored = db.scalar(select(User).where(User.email == NEW_USER["email"]))
    assert stored.password_hash.startswith("$argon2")
    assert NEW_USER["password"] not in stored.password_hash
    login = anon.post(
        f"{API}/auth/login", json={"email": NEW_USER["email"], "password": NEW_USER["password"]}
    )
    assert login.status_code == 200


def test_manager_cannot_create_user(manager):
    assert_error(manager.post(f"{API}/users", json=NEW_USER), 403, "FORBIDDEN")


def test_duplicate_email_is_rejected_case_insensitively(admin, world):
    payload = {**NEW_USER, "email": world.viewer.email.upper()}
    assert_error(admin.post(f"{API}/users", json=payload), 409, "DUPLICATE_EMAIL")


def test_short_password_is_rejected_without_echoing_it(admin):
    response = admin.post(f"{API}/users", json={**NEW_USER, "password": "short-pw"})
    error = assert_error(response, 422, "VALIDATION_ERROR")
    assert error["details"][0]["field"] == "body.password"
    assert "short-pw" not in response.text


def test_customer_account_must_be_a_viewer(admin, world):
    payload = {**NEW_USER, "customer_id": str(world.customer_a.id)}
    assert_error(admin.post(f"{API}/users", json=payload), 422, "VALIDATION_ERROR")


def test_extra_fields_cannot_be_smuggled_in(admin):
    response = admin.post(f"{API}/users", json={**NEW_USER, "is_superuser": True})
    assert_error(response, 422, "VALIDATION_ERROR")


def test_role_change_revokes_existing_sessions(admin, viewer, world):
    assert viewer.get(f"{API}/auth/me").json()["role"] == "VIEWER"
    response = admin.patch(f"{API}/users/{world.viewer.id}", json={"role": "MANAGER"})
    assert response.status_code == 200
    assert response.json()["role"] == "MANAGER"
    assert_error(viewer.get(f"{API}/auth/me"), 401, "INVALID_SESSION")


def test_name_change_keeps_sessions(admin, viewer, world):
    admin.patch(f"{API}/users/{world.viewer.id}", json={"full_name": "Renamed"})
    assert viewer.get(f"{API}/auth/me").json()["full_name"] == "Renamed"


def test_deactivation_revokes_existing_sessions(admin, viewer, world):
    admin.patch(f"{API}/users/{world.viewer.id}", json={"is_active": False})
    assert_error(viewer.get(f"{API}/auth/me"), 401, "INVALID_SESSION")


def test_admin_cannot_lock_themselves_out(admin, world):
    for change in ({"role": "VIEWER"}, {"is_active": False}):
        response = admin.patch(f"{API}/users/{world.admin.id}", json=change)
        assert_error(response, 409, "SELF_MODIFICATION")


def test_user_changes_are_audited(admin, world, db):
    admin.patch(f"{API}/users/{world.viewer.id}", json={"role": "MANAGER"})
    entry = db.scalar(select(AuditLog).where(AuditLog.action == "user.updated"))
    assert entry.actor_user_id == world.admin.id
    assert entry.entity_id == str(world.viewer.id)


def test_unknown_user_is_404(admin):
    response = admin.get(f"{API}/users/00000000-0000-4000-8000-000000000000")
    assert_error(response, 404, "NOT_FOUND")


def test_password_constant_is_not_returned_on_login(anon, world):
    response = anon.post(
        f"{API}/auth/login", json={"email": world.admin.email, "password": PASSWORD}
    )
    assert PASSWORD not in response.text
