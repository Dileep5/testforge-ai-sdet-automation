import { expect, test } from "../../framework/fixtures/api";
import { PREFIX, readApiError } from "../../framework/helpers/api-client";

const UUID = /^[0-9a-f-]{36}$/;

test.describe("errors and platform behaviour", { tag: "@api" }, () => {
  test("liveness and readiness report without a session", async ({ anonymous }) => {
    expect(await (await anonymous.send("GET", "/health")).json()).toEqual({ status: "ok" });
    const ready = await anonymous.send("GET", "/ready");
    expect(ready.status()).toBe(200);
    expect(await ready.json()).toMatchObject({ status: "ready", database: "ok" });
  });

  test("an unknown route uses the standard error envelope", async ({ unchecked }) => {
    const error = await readApiError(await unchecked.send("GET", "/no-such-route"), 404, "NOT_FOUND");
    expect(error.message).toBe("The requested resource was not found");
    expect(error.request_id).toMatch(UUID);
  });

  test("the wrong method uses the standard error envelope", async ({ unchecked }) => {
    const error = await readApiError(await unchecked.send("DELETE", "/health"), 405, "METHOD_NOT_ALLOWED");
    expect(error.request_id).toMatch(UUID);
  });

  test("malformed JSON is a 400 and never reaches the handler", async ({ asManager }) => {
    const response = await asManager.api.send("POST", "/products", { data: Buffer.from('{"sku": '), headers: { "Content-Type": "application/json" } });
    await readApiError(response, 400, "INVALID_JSON");
  });

  test("a body that is not JSON is refused", async ({ asManager }) => {
    const response = await asManager.api.send("POST", "/products", { data: "sku=ABC", headers: { "Content-Type": "text/plain" } });
    await readApiError(response, 422, "VALIDATION_ERROR");
  });

  test("an empty body on a write is refused", async ({ asManager }) => {
    await readApiError(await asManager.api.send("POST", "/products"), 422, "VALIDATION_ERROR");
  });

  test("every response has its own server-generated request id, matching the error body", async ({ anonymous }) => {
    const responses = await Promise.all([anonymous.send("GET", "/auth/me"), anonymous.send("GET", "/auth/me"), anonymous.send("GET", "/health")]);
    const ids = responses.map((response) => response.headers()["x-request-id"]);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(UUID);
    expect(((await responses[0]?.json()) as { error: { request_id: string } }).error.request_id).toBe(ids[0]);
  });

  test("a client cannot choose its own request id", async ({ anonymous }) => {
    const forged = 'attacker\tvalue';
    const response = await anonymous.request.fetch(`${PREFIX}/auth/me`, { headers: { "X-Request-ID": forged } });
    expect(response.headers()["x-request-id"]).not.toBe(forged);
    expect(response.headers()["x-request-id"]).toMatch(UUID);
  });

  test("responses carry the nosniff header, including errors", async ({ anonymous }) => {
    for (const path of ["/health", "/auth/me"]) {
      expect((await anonymous.send("GET", path)).headers()["x-content-type-options"]).toBe("nosniff");
    }
  });

  test("text containing a NUL byte is refused, not crashed on", async ({ asManager, data }) => {
    await readApiError(await asManager.api.send("GET", "/products", { params: { q: "a\u0000b" } }), 422, "INVALID_DATA");
    const body = { sku: data.unique("SKU"), name: "a\u0000b", category: "E2E", unit_price_cents: 1 };
    await readApiError(await asManager.api.send("POST", "/products", { data: body }), 422, "INVALID_DATA");
  });

  test("the dashboard reports consistent totals", async ({ asViewer }) => {
    const summary = await asViewer.api.dashboard();
    const counted = Object.values(summary.orders_by_status).reduce((sum, count) => sum + (count ?? 0), 0);
    expect(summary.total_orders).toBe(counted);
    expect(summary.recent_orders.length).toBeLessThanOrEqual(5);
    expect(Number.isInteger(summary.settled_revenue_cents)).toBe(true);
  });
});
