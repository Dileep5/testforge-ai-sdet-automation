import { SEED_USERS, expect, test } from "../../framework/fixtures";

// Fails on purpose, after typing a real password and causing a console error and a failed response.
test("a failed test leaves evidence behind", async ({ anon }) => {
  await anon.app.login.goto();
  await anon.page.getByLabel("Email").fill(SEED_USERS.manager.email);
  await anon.page.getByLabel("Password").fill(SEED_USERS.manager.password);
  await anon.page.getByRole("button", { name: "Sign in" }).click();
  await expect(anon.page.getByTestId("stat-total-orders")).toBeVisible();
  await anon.page.route("**/api/v1/orders*", (route) => route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "x", details: [], request_id: "r" } } }));
  await anon.page.goto("/orders");
  await expect(anon.page.getByTestId("deliberately-missing")).toBeVisible({ timeout: 1_000 });
});
