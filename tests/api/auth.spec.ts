import { expect, test } from "../../framework/fixtures/api";
import { SEED_USERS } from "../../framework/fixtures";
import { expectValidationError, readApiError } from "../../framework/helpers/api-client";
import { SESSION_COOKIE } from "../../framework/config";
import { expireSession } from "../../framework/helpers/database";

test.describe("authentication", { tag: "@api" }, () => {
  test("login returns the user with role permissions and sets a hardened session cookie", async ({ anonymous }) => {
    const before = Date.now();
    const response = await anonymous.send("POST", "/auth/login", { data: SEED_USERS.manager });
    expect(response.status()).toBe(200);
    const user = (await response.json()) as { email: string; role: string; permissions: string[]; session_expires_at: string };
    expect(user.email).toBe(SEED_USERS.manager.email);
    expect(user.role).toBe("MANAGER");
    expect(user.permissions).toEqual(["inventory:write", "orders:write", "payments:write", "products:write"]);
    const eightHours = 8 * 60 * 60 * 1000;
    expect(Date.parse(user.session_expires_at)).toBeGreaterThanOrEqual(before + eightHours - 1000);

    const cookie = response.headersArray().find((header) => header.name.toLowerCase() === "set-cookie")?.value ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=28800");
    expect((await anonymous.me()).email).toBe(SEED_USERS.manager.email);
  });

  test("email matching ignores case", async ({ anonymous }) => {
    const response = await anonymous.send("POST", "/auth/login", {
      data: { email: SEED_USERS.viewer.email.toUpperCase(), password: SEED_USERS.viewer.password },
    });
    expect(response.status()).toBe(200);
  });

  test("wrong password, unknown email and deactivated user are indistinguishable", async ({ anonymous, data, setupApi }) => {
    const deactivated = await data.user("VIEWER");
    await setupApi.updateUser(deactivated.user.id, { is_active: false });
    const attempts = [
      { email: SEED_USERS.admin.email, password: "not-the-password" },
      { email: `${data.unique("nobody").toLowerCase()}@e2e.example`, password: "not-the-password" },
      { email: deactivated.email, password: deactivated.password },
    ];
    const errors = await Promise.all(
      attempts.map(async (data) => readApiError(await anonymous.send("POST", "/auth/login", { data }), 401, "INVALID_CREDENTIALS")),
    );
    expect(new Set(errors.map((error) => error.message))).toEqual(new Set(["Incorrect email or password"]));
    expect(errors.flatMap((error) => error.details)).toEqual([]);
  });

  test("a failed login with a long but valid email is still a plain 401", async ({ anonymous }) => {
    const email = `${"a".repeat(60)}@${"b".repeat(60)}.example`;
    const response = await anonymous.send("POST", "/auth/login", { data: { email, password: "not-the-password" } });
    await readApiError(response, 401, "INVALID_CREDENTIALS");
  });

  const invalidLogins: { name: string; data: unknown; field: string }[] = [
    { name: "missing email", data: { password: "x" }, field: "body.email" },
    { name: "missing password", data: { email: SEED_USERS.admin.email }, field: "body.password" },
    { name: "malformed email", data: { email: "not-an-email", password: "x" }, field: "body.email" },
    { name: "numeric email", data: { email: 12345, password: "x" }, field: "body.email" },
    { name: "numeric password", data: { email: SEED_USERS.admin.email, password: 12345 }, field: "body.password" },
    { name: "empty password", data: { email: SEED_USERS.admin.email, password: "" }, field: "body.password" },
    { name: "oversized password", data: { email: SEED_USERS.admin.email, password: "x".repeat(257) }, field: "body.password" },
    { name: "extra field", data: { ...SEED_USERS.admin, role: "ADMIN" }, field: "body.role" },
    { name: "array instead of object", data: [SEED_USERS.admin], field: "body" },
  ];
  for (const { name, data, field } of invalidLogins) {
    test(`login rejects ${name}`, async ({ anonymous }) => {
      await expectValidationError(await anonymous.send("POST", "/auth/login", { data }), field);
    });
  }

  test("/auth/me needs a session, and rejects a forged one", async ({ anonymous, withCookie }) => {
    await readApiError(await anonymous.send("GET", "/auth/me"), 401, "NOT_AUTHENTICATED");
    const forged = await withCookie("forged-session-token");
    await readApiError(await forged.send("GET", "/auth/me"), 401, "INVALID_SESSION");
  });

  test("logout revokes the session on the server and clears the cookie", async ({ loginAs, withCookie }) => {
    const session = await loginAs(SEED_USERS.viewer);
    const token = await session.sessionCookie();
    const response = await session.api.send("POST", "/auth/logout");
    expect(response.status()).toBe(204);
    expect(response.headers()["set-cookie"]).toContain(`${SESSION_COOKIE}=""`);
    const replay = await withCookie(token);
    await readApiError(await replay.send("GET", "/auth/me"), 401, "INVALID_SESSION");
  });

  test("logout is idempotent, with or without a session", async ({ anonymous, withCookie, loginAs }) => {
    expect((await anonymous.send("POST", "/auth/logout")).status()).toBe(204);
    const session = await loginAs(SEED_USERS.viewer);
    const replay = await withCookie(await session.sessionCookie());
    expect((await replay.send("POST", "/auth/logout")).status()).toBe(204);
    expect((await replay.send("POST", "/auth/logout")).status()).toBe(204);
  });

  test("sessions are independent: ending one leaves the other signed in", async ({ loginAs }) => {
    const [first, second] = await Promise.all([loginAs(SEED_USERS.viewer), loginAs(SEED_USERS.viewer)]);
    expect(await first.sessionCookie()).not.toBe(await second.sessionCookie());
    await first.api.logout();
    await readApiError(await first.api.send("GET", "/auth/me"), 401, "NOT_AUTHENTICATED");
    expect((await second.api.me()).email).toBe(SEED_USERS.viewer.email);
  });

  test("an expired session is refused with a distinct code", async ({ loginAs, data }) => {
    // A user of its own: logging in removes that user's expired sessions, so a shared one could race.
    const session = await loginAs(await data.user("VIEWER"));
    await expireSession(await session.sessionCookie());
    await readApiError(await session.api.send("GET", "/auth/me"), 401, "SESSION_EXPIRED");
  });
});
