import { apiLogin, expect, test } from "../../framework/fixtures";

const short = { timeout: 1_500 };

test("case H01", async ({ manager }) => {
  await manager.page.route("**/api/v1/products*", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "OVERLOADED", message: "x", details: [], request_id: "r" } }) }));
  await manager.page.goto("/products");
  await expect(manager.page.locator("table tbody tr").first()).toBeVisible(short);
});

test("case H02", async ({ manager }) => {
  await manager.page.route("**/api/v1/dashboard/summary", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, low_stock_count: 987654 } });
  });
  const expected = (await manager.api.dashboard()).low_stock_count;
  await manager.page.goto("/");
  await expect(manager.page.getByTestId("stat-low-stock")).toHaveText(new RegExp(`^\\D*${expected}$`), short);
});

test("case H03", async ({ manager }) => {
  await manager.page.route("**/api/v1/dashboard/summary", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "<html>not json</html>" }));
  await manager.page.goto("/");
  await expect(manager.page.getByTestId("stat-total-orders")).toBeVisible(short);
});

test("case H04", async ({ manager }) => {
  await manager.page.goto("/");
  await expect(manager.page.getByTestId("stat-total-orders")).toBeVisible();
  await manager.page.locator(".does-not-exist").click(short);
});

test("case H05", async ({ manager }) => {
  await manager.page.goto("/orders");
  await expect(manager.page.getByRole("heading", { level: 1 })).toBeVisible();
  await manager.page.getByRole("button").click();
});

test("case H06", async ({ manager }) => {
  await manager.page.goto("/support");
  await expect(manager.page.getByRole("heading", { level: 1 })).toBeVisible();
  await manager.page.getByLabel("No such field").fill("text", short);
});

test("case H07", async ({ manager }) => {
  await manager.page.route("**/api/v1/products*", () => undefined);
  await manager.page.goto("/products");
  await expect(manager.page.locator("table tbody tr").first()).toBeVisible(short);
});

test("case H08", async ({ manager }) => {
  test.setTimeout(3_000);
  await manager.page.route("**/api/v1/inventory*", () => undefined);
  await manager.page.goto("/inventory");
  await new Promise(() => undefined);
});

test("case H09", async ({ manager }) => {
  await manager.page.route("**/support", () => undefined);
  await manager.page.goto("/support", short);
});

test("case H10", async ({ manager }) => {
  await manager.page.goto("http://testforge.invalid/");
});

test("case H11", async ({ manager }) => {
  await manager.context.close();
  await manager.page.goto("/");
});

test("case H12", async ({ playwright }) => {
  const request = await playwright.request.newContext();
  await request.post("http://127.0.0.1:59999/api/v1/auth/login", { data: {} });
});

test("case H13", async ({ playwright }) => {
  await apiLogin(playwright, { email: "viewer@testforge.example", password: "Wrong-Password-For-Seed-1" });
});

test("case H14", async ({ data, setupApi }) => {
  const product = await data.product();
  const response = await setupApi.send("POST", "/products", { data: { sku: product.sku, name: "Copy", category: product.category, price_cents: 100 } });
  if (!response.ok()) throw new Error(`Could not create product: ${response.status()} ${await response.text()}`);
});

test("case H15", async ({ data }) => {
  const customer = await data.customer();
  const product = await data.product({ stock: { YYC1: 2 } });
  await data.order({ customer, warehouse: "YYC1", lines: [{ product, quantity: 3 }] });
});

test("case H16", async () => {
  expect("abc" as string).toBe("abd");
});

test("case H17", async () => {
  throw new Error("Assertion helper not configured");
});

test("case H18", async () => {
  JSON.parse("{");
});
