import { SESSION_COOKIE } from "../../framework/config";
import { SEED_USERS, expect, test } from "../../framework/fixtures";
import { expectApiError } from "../../framework/helpers/api-client";
import { expireSession } from "../../framework/helpers/database";

test.describe("authentication", { tag: "@regression" }, () => {
  test("valid login creates a protected session and shows who is signed in", { tag: ["@smoke", "@critical"] }, async ({ anon }) => {
    const { app, context } = anon;
    await app.login.goto();
    const response = await app.login.signIn(SEED_USERS.manager);
    expect(response.status()).toBe(200);

    await expect(app.nav.currentUser).toHaveText("Morgan Manager");
    await expect(app.nav.currentRole).toHaveText("Manager");
    await expect(app.page).toHaveURL(/\/$/);

    const cookie = (await context.cookies()).find((item) => item.name === SESSION_COOKIE);
    expect(cookie?.httpOnly, "session cookie must not be readable from scripts").toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
  });

  test("invalid credentials show one generic error and create no session", { tag: "@smoke" }, async ({ anon, data, db }) => {
    const { app, context } = anon;
    await app.login.goto();
    const email = `nobody-${data.namespace.toLowerCase()}@e2e.example`;
    const unknown = await app.login.signIn({ email, password: "wrong-password" });
    expect(unknown.status()).toBe(401);
    await expect(app.login.error).toHaveText("Incorrect email or password");
    await expect(app.login.password).toHaveValue("");

    // A real account with the wrong password must look exactly the same.
    const wrong = await app.login.signIn({ email: SEED_USERS.manager.email, password: "wrong-password" });
    expect(wrong.status()).toBe(401);
    await expect(app.login.error).toHaveText("Incorrect email or password");
    expect((await context.cookies()).some((item) => item.name === SESSION_COOKIE)).toBe(false);

    const audit = await db.audit(email, "auth.login_failed");
    expect(audit).toHaveLength(1);
  });

  test("login validation errors disappear as soon as the field is corrected", async ({ anon }) => {
    const { app } = anon;
    const emailError = app.page.getByText("Enter your email address");
    const passwordError = app.page.getByText("Enter your password");
    await app.login.goto();
    await app.login.submitButton.click();
    await expect(emailError).toBeVisible();
    await expect(passwordError).toBeVisible();
    await expect(app.login.email).toHaveAttribute("aria-invalid", "true");

    await app.login.email.fill("someone@e2e.example");
    await expect(emailError).toBeHidden();
    await expect(app.login.email).not.toHaveAttribute("aria-invalid", "true");
    await expect(passwordError).toBeVisible();

    await app.login.password.fill("anything");
    await expect(passwordError).toBeHidden();
  });

  test("logout ends the session on the server, not just in the browser", { tag: "@critical" }, async ({ manager, playwright, baseURL }) => {
    const { app, sessionCookie } = manager;
    const token = await sessionCookie();
    await app.dashboard.goto();
    await app.nav.signOut();

    // Replay the old cookie from a separate client, as an attacker holding a stolen copy would.
    const replay = await playwright.request.newContext({
      baseURL: baseURL ?? "",
      extraHTTPHeaders: { Cookie: `${SESSION_COOKIE}=${token}` },
    });
    await expectApiError(await replay.get("/api/v1/auth/me"), 401, "INVALID_SESSION");
    await replay.dispose();

    await app.orders.page.goto("/orders");
    await expect(app.page).toHaveURL(/\/login$/);
  });

  test("an expired session returns to login with a message, then back to the same page", { tag: "@critical" }, async ({ data, signIn }) => {
    // A user of its own, because this test deliberately ages the session.
    const created = await data.user("MANAGER");
    const { app, sessionCookie } = await signIn(created);
    await app.orders.goto();
    await expireSession(await sessionCookie());

    await app.nav.goTo("Products");
    await expect(app.login.sessionEnded).toContainText("Your session has ended");
    await expect(app.page).toHaveURL(/\/login$/);

    await app.login.signIn(created);
    await expect(app.page).toHaveURL(/\/products$/);
    await expect(app.products.grid.table).toBeVisible();
  });

  test("a protected page redirects to login and returns there afterwards", { tag: "@smoke" }, async ({ anon }) => {
    const { app } = anon;
    await app.page.goto("/inventory?low_stock=true");
    await expect(app.page).toHaveURL(/\/login$/);
    await app.login.signIn(SEED_USERS.viewer);
    await expect(app.page).toHaveURL(/\/inventory\?low_stock=true$/);
    await expect(app.page.getByLabel("Low stock only")).toBeChecked();
  });

  test("a crafted next link cannot send the user to another site after login", async ({ anon, baseURL }) => {
    const { app } = anon;
    await app.page.goto("/login?next=//evil.example/phish");
    await app.login.signIn(SEED_USERS.viewer);
    await expect(app.nav.currentUser).toBeVisible();
    expect(new URL(app.page.url()).origin).toBe(baseURL);
    await expect(app.page).toHaveURL(/\/$/);
  });
});
