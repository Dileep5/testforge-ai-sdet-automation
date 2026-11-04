import type { APIResponse } from "@playwright/test";
import { expect, test } from "../../framework/fixtures/api";
import { PREFIX, type ApiClient } from "../../framework/helpers/api-client";

// Well above the 30 database connections and 40 worker threads, and fixed, so each run is the same.
// It stays below macOS's listen queue of 128 (kern.ipc.somaxconn): beyond that, the operating system
// resets new connections before the API sees them, which says nothing about the API. The 300-request
// burst in apps/api/tests/test_concurrency_limit.py connects more gradually.
const BURST = 100;
// Shorter than the 30 second pool timeout, so the old deadlock shows up as failures here.
const REQUEST_TIMEOUT_MS = 25_000;

async function statusCounts(calls: Promise<APIResponse>[]): Promise<Record<string, number>> {
  const outcomes = await Promise.allSettled(calls);
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) {
    // A client-side failure is kept by message, so a report says what actually went wrong.
    const key = outcome.status === "fulfilled" ? String(outcome.value.status()) : String(outcome.reason).split("\n")[0] ?? "request failed";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function get(api: ApiClient, path: string): Promise<APIResponse> {
  return api.request.fetch(`${PREFIX}${path}`, { timeout: REQUEST_TIMEOUT_MS });
}

test.describe("behaviour under a bounded request burst", { tag: "@reliability" }, () => {
  test.setTimeout(90_000);

  test("a read burst above pool capacity completes: the connection and thread deadlock stays fixed", async ({ asViewer }) => {
    const counts = await statusCounts(Array.from({ length: BURST }, () => get(asViewer.api, "/products")));
    expect(counts).toEqual({ "200": BURST });
    // The API is still usable straight afterwards, with connections back in the pool.
    expect((await asViewer.api.me()).email).toBe(asViewer.user.email);
  });

  test("a mixed burst of list, detail and CSV reads completes", async ({ asAdmin }) => {
    const paths = ["/orders", "/inventory", "/dashboard/summary", "/orders/export.csv", "/audit-logs"];
    const calls = Array.from({ length: BURST }, (_, index) => get(asAdmin.api, paths[index % paths.length] ?? "/orders"));
    expect(await statusCounts(calls)).toEqual({ "200": BURST });
  });

  test("an order burst on limited stock sells exactly the stock, and every request gets an answer", async ({ asManager, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 40 } });
    const warehouse = await data.warehouse("YYZ1");
    const body = { customer_id: customer.id, warehouse_id: warehouse.id, items: [{ product_id: product.id, quantity: 1 }] };
    const calls = Array.from({ length: BURST }, () =>
      asManager.api.request.fetch(`${PREFIX}/orders`, { method: "POST", data: body, timeout: REQUEST_TIMEOUT_MS }),
    );
    expect(await statusCounts(calls)).toEqual({ "201": 40, "409": 60 });
    expect(await db.stock(product.id, "YYZ1")).toBe(0);
    expect(await db.countOrdersForCustomer(customer.id)).toBe(40);
    const [row] = await db.query<{ version: number }>(`SELECT i.version FROM inventory i JOIN warehouses w ON w.id = i.warehouse_id WHERE i.product_id = $1 AND w.code = 'YYZ1'`, [product.id]);
    // One bump when the factory set the stock, then one for each of the 40 orders.
    expect(row?.version).toBe(42);
  });

  test("slow gateway calls queue without exhausting the pool", async ({ asManager, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const slow = Array.from({ length: 40 }, () =>
      asManager.api.request.fetch(`${PREFIX}/orders/${order.id}/payments`, {
        method: "POST",
        data: { method_token: "sim_timeout" },
        headers: { "Idempotency-Key": data.unique("key") },
        timeout: REQUEST_TIMEOUT_MS,
      }),
    );
    const reads = Array.from({ length: 60 }, () => get(asManager.api, "/products"));
    const [slowCounts, readCounts] = await Promise.all([statusCounts(slow), statusCounts(reads)]);
    expect(slowCounts).toEqual({ "201": 40 });
    expect(readCounts).toEqual({ "200": 60 });
    const rows = await db.payments(order.id);
    expect(rows).toHaveLength(40);
    expect(new Set(rows.map((row) => row.status))).toEqual(new Set(["TIMED_OUT"]));
  });

  test("liveness is exempt from the queue and answers during a burst", async ({ asViewer, unchecked }) => {
    const burst = Array.from({ length: BURST }, () => get(asViewer.api, "/products"));
    const health = await unchecked.send("GET", "/health");
    expect(health.status()).toBe(200);
    expect(await statusCounts(burst)).toEqual({ "200": BURST });
  });
});
