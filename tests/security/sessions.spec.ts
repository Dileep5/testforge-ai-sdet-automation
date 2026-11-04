import { createHash } from "node:crypto";
import { expect, test } from "../../framework/fixtures/api";
import { SEED_USERS } from "../../framework/fixtures";
import { readApiError } from "../../framework/helpers/api-client";
import { expireSession } from "../../framework/helpers/database";

test.describe("session invalidation", { tag: "@security" }, () => {
  test("changing a role ends every session of that user at once", async ({ loginAs, setupApi, data, withCookie }) => {
    const user = await data.user("MANAGER");
    const [first, second] = await Promise.all([loginAs(user), loginAs(user)]);
    const tokens = [await first.sessionCookie(), await second.sessionCookie()];
    await setupApi.updateUser(user.user.id, { role: "VIEWER" });
    for (const token of tokens) {
      const replay = await withCookie(token);
      await readApiError(await replay.send("GET", "/auth/me"), 401, "INVALID_SESSION");
    }
    expect((await (await loginAs(user)).api.me()).role).toBe("VIEWER");
  });

  test("deactivation ends sessions, and reactivation does not revive them", async ({ loginAs, setupApi, data, anonymous }) => {
    const user = await data.user("MANAGER");
    const session = await loginAs(user);
    await setupApi.updateUser(user.user.id, { is_active: false });
    await readApiError(await session.api.send("GET", "/auth/me"), 401, "INVALID_SESSION");
    await readApiError(await anonymous.send("POST", "/auth/login", { data: { email: user.email, password: user.password } }), 401, "INVALID_CREDENTIALS");
    await setupApi.updateUser(user.user.id, { is_active: true });
    await readApiError(await session.api.send("GET", "/auth/me"), 401, "INVALID_SESSION");
    expect((await (await loginAs(user)).api.me()).email).toBe(user.email);
  });

  test("a session revoked mid-way cannot write", async ({ loginAs, setupApi, data }) => {
    const user = await data.user("MANAGER");
    const session = await loginAs(user);
    const product = await data.product();
    expect((await session.api.send("PATCH", `/products/${product.id}`, { data: { description: "allowed" } })).status()).toBe(200);
    await setupApi.updateUser(user.user.id, { is_active: false });
    await readApiError(await session.api.send("PATCH", `/products/${product.id}`, { data: { description: "denied" } }), 401, "INVALID_SESSION");
    expect((await setupApi.product(product.id)).description).toBe("allowed");
  });

  test("an unrelated edit does not end a session", async ({ loginAs, setupApi, data }) => {
    const user = await data.user("MANAGER");
    const session = await loginAs(user);
    await setupApi.updateUser(user.user.id, { role: "MANAGER" });
    expect((await session.api.me()).email).toBe(user.email);
  });

  test("an expired session cannot read or write", async ({ loginAs, data }) => {
    const user = await data.user("MANAGER");
    const session = await loginAs(user);
    const product = await data.product();
    await expireSession(await session.sessionCookie());
    await readApiError(await session.api.send("GET", "/orders"), 401, "SESSION_EXPIRED");
    await readApiError(await session.api.send("PATCH", `/products/${product.id}`, { data: { name: "expired" } }), 401, "SESSION_EXPIRED");
  });

  test("logging in does not adopt a cookie the client already had", async ({ withCookie }) => {
    const attacker = "attacker-chosen-session-value";
    const client = await withCookie(attacker);
    const response = await client.send("POST", "/auth/login", { data: SEED_USERS.viewer });
    expect(response.status()).toBe(200);
    expect(response.headers()["set-cookie"]).not.toContain(attacker);
    const replay = await withCookie(attacker);
    await readApiError(await replay.send("GET", "/auth/me"), 401, "INVALID_SESSION");
  });

  test("only a hash of the token is stored, and the hash is not itself a credential", async ({ asViewer, db, withCookie }) => {
    const token = await asViewer.sessionCookie();
    const hash = createHash("sha256").update(token).digest("hex");
    const [row] = await db.query<{ token_hash: string }>(`SELECT token_hash FROM sessions WHERE token_hash = $1`, [hash]);
    expect(row?.token_hash).toBe(hash);
    expect(await db.query(`SELECT 1 FROM sessions WHERE token_hash = $1`, [token])).toEqual([]);
    const fromDump = await withCookie(hash);
    await readApiError(await fromDump.send("GET", "/auth/me"), 401, "INVALID_SESSION");
  });

  test("session tokens are long and do not repeat", async ({ loginAs }) => {
    const sessions = await Promise.all([loginAs(SEED_USERS.viewer), loginAs(SEED_USERS.viewer), loginAs(SEED_USERS.viewer)]);
    const tokens = await Promise.all(sessions.map((session) => session.sessionCookie()));
    expect(new Set(tokens).size).toBe(3);
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(43);
  });

  const forged: { label: string; value: string; code: string }[] = [
    { label: "empty", value: "", code: "NOT_AUTHENTICATED" },
    { label: "null", value: "null", code: "INVALID_SESSION" },
    { label: "zero", value: "0", code: "INVALID_SESSION" },
    { label: "SQL", value: "x'; DROP TABLE sessions;--", code: "INVALID_SESSION" },
    { label: "oversized", value: "a".repeat(10_000), code: "INVALID_SESSION" },
    { label: "path traversal", value: "../../etc/passwd", code: "INVALID_SESSION" },
  ];
  for (const { label, value, code } of forged) {
    test(`a forged cookie is refused: ${label}`, async ({ withCookie }) => {
      const client = await withCookie(value);
      await readApiError(await client.send("GET", "/auth/me"), 401, code);
    });
  }
});
