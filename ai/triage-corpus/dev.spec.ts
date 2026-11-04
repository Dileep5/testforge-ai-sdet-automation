import { apiLogin, expect, test } from "../../framework/fixtures";

const short = { timeout: 1_500 };

test("case D01", async ({ manager }) => {
  await manager.page.route("**/api/v1/orders*", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "x", details: [], request_id: "r" } }) }));
  await manager.page.goto("/orders");
  await expect(manager.page.getByTestId("orders-grid").locator("tbody tr").first()).toBeVisible(short);
});

test("case D02", async ({ manager }) => {
  await manager.page.route("**/api/v1/dashboard/summary", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, total_orders: 424242 } });
  });
  const expected = (await manager.api.dashboard()).total_orders;
  await manager.page.goto("/");
  await expect(manager.page.getByTestId("stat-total-orders")).toContainText(String(expected), short);
});

test("case D03", async ({ manager }) => {
  await manager.page.addInitScript(() => setTimeout(() => { throw new Error("Cannot read properties of undefined (reading 'status')"); }, 0));
  await manager.page.goto("/");
  await expect(manager.page.getByTestId("stat-total-orders")).toBeVisible();
});

test("case D04", async ({ manager }) => {
  await manager.page.goto("/");
  await expect(manager.page.getByTestId("stat-total-orders")).toBeVisible();
  await manager.page.getByTestId("no-such-button").click(short);
});

test("case D05", async ({ manager }) => {
  await manager.page.goto("/");
  await expect(manager.page.getByTestId("stat-total-orders")).toBeVisible();
  await manager.page.getByRole("link").click();
});

test("case D06", async ({ manager }) => {
  await manager.page.goto("/");
  await expect(manager.page.getByTestId("stat-total-orders")).toBeVisible();
  await expect(manager.page.getByRole("heading", { name: "Dashbord" })).toBeVisible(short);
});

test("case D07", async ({ manager }) => {
  await manager.page.route("**/api/v1/dashboard/summary", () => undefined);
  await manager.page.goto("/");
  await expect(manager.page.getByTestId("stat-total-orders")).toBeVisible(short);
});

test("case D08", async ({ manager }) => {
  await manager.page.goto("/");
  await manager.page.waitForResponse("**/api/v1/never-called", short);
});

test("case D09", async ({ manager }) => {
  test.setTimeout(3_000);
  await manager.page.route("**/api/v1/products*", () => undefined);
  await manager.page.goto("/products");
  await manager.page.waitForResponse("**/api/v1/products*", { timeout: 60_000 });
});

test("case D10", async ({ manager }) => {
  await manager.page.goto("http://127.0.0.1:59999/");
});

test("case D11", async ({ playwright }) => {
  const request = await playwright.request.newContext();
  await request.get("http://127.0.0.1:59999/api/v1/health");
});

test("case D13", async ({ playwright }) => {
  await apiLogin(playwright, { email: "nobody-here@e2e.example", password: "Not-A-Real-Password-1" });
});

test("case D14", async ({ data }) => {
  const customer = await data.customer();
  const product = await data.product({ stock: { YYZ1: 1 } });
  await data.order({ customer, lines: [{ product, quantity: 50 }] });
});

test("case D15", async ({ setupApi }) => {
  const response = await setupApi.send("GET", "/customers/00000000-0000-4000-8000-000000000000");
  if (!response.ok()) throw new Error(`Setup: seeded customer not found: ${response.status()} ${await response.text()}`);
});

test("case D16", async () => {
  throw new Error("Unexpected state in helper");
});

test("case D17", async () => {
  expect(2 as number).toBe(3);
});

test("case D18", async () => {
  const value = undefined as unknown as { foo: string };
  expect(value.foo).toBe("x");
});
