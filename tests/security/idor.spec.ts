import type { APIResponse } from "@playwright/test";
import { expect, test, type ApiBuyer } from "../../framework/fixtures/api";
import type { TestData } from "../../framework/factories/test-data";
import { parseCsv } from "../../framework/helpers/csv";
import type { OrderDetail, Payment } from "../../framework/helpers/types";

async function orderFor(buyer: ApiBuyer, data: TestData): Promise<{ order: OrderDetail; payment: Payment }> {
  const product = await data.product({ stock: { YYZ1: 10 } });
  const order = await data.order({ customer: buyer.customer, lines: [{ product, quantity: 1 }] });
  return { order, payment: await data.pay(order) };
}

/** A resource another customer owns must look the same as one that does not exist. */
async function expectSameAsMissing(denied: APIResponse, missing: APIResponse): Promise<void> {
  expect(denied.status()).toBe(404);
  const body = async (response: APIResponse) => {
    const { error } = (await response.json()) as { error: { code: string; message: string; details: unknown } };
    return { code: error.code, message: error.message, details: error.details };
  };
  expect(await body(denied)).toEqual(await body(missing));
}

const MISSING = "00000000-0000-4000-8000-000000000000";

test.describe("cross-customer access (IDOR)", { tag: "@security" }, () => {
  const reads: { name: string; path: (ids: { order: string; payment: string }) => string }[] = [
    { name: "an order", path: ({ order }) => `/orders/${order}` },
    { name: "an order's history", path: ({ order }) => `/orders/${order}/history` },
    { name: "an order's payments", path: ({ order }) => `/orders/${order}/payments` },
    { name: "a payment", path: ({ payment }) => `/payments/${payment}` },
  ];
  for (const { name, path } of reads) {
    test(`a buyer can read their own ${name.replace(/^an? /, "")}, but another customer's looks missing`, async ({ asBuyer, newBuyer, data }) => {
      const other = await newBuyer();
      const mine = await orderFor(asBuyer, data);
      const theirs = await orderFor(other, data);
      const own = path({ order: mine.order.id, payment: mine.payment.id });
      expect((await asBuyer.api.send("GET", own)).status()).toBe(200);
      const denied = await asBuyer.api.send("GET", path({ order: theirs.order.id, payment: theirs.payment.id }));
      const missing = await asBuyer.api.send("GET", path({ order: MISSING, payment: MISSING }));
      await expectSameAsMissing(denied, missing);
      expect(await denied.text()).not.toContain(theirs.order.order_number);
    });
  }

  test("the customer filter cannot widen a buyer's scope", async ({ asBuyer, newBuyer, data }) => {
    const other = await newBuyer();
    const mine = await orderFor(asBuyer, data);
    const theirs = await orderFor(other, data);
    expect((await asBuyer.api.listOrders({ customer_id: other.customer.id })).total).toBe(0);
    expect((await asBuyer.api.listOrders({ q: theirs.order.order_number })).total).toBe(0);
    const listed = await asBuyer.api.listOrders({ page_size: 100 });
    expect(listed.items.map((order) => order.id)).toEqual([mine.order.id]);
  });

  test("the CSV export only ever contains the buyer's own orders", async ({ asBuyer, newBuyer, data }) => {
    const other = await newBuyer();
    const mine = await orderFor(asBuyer, data);
    const theirs = await orderFor(other, data);
    const plain = await asBuyer.api.send("GET", "/orders/export.csv");
    const rows = parseCsv(await plain.text());
    expect(rows.map((row) => row.order_number)).toEqual([mine.order.order_number]);
    const filtered = await asBuyer.api.send("GET", "/orders/export.csv", { params: { customer_id: other.customer.id } });
    expect(parseCsv(await filtered.text())).toEqual([]);
    expect(await plain.text()).not.toContain(theirs.order.order_number);
    expect(await plain.text()).not.toContain(other.customer.code);
  });

  test("the dashboard and customer list do not reveal other customers", async ({ asBuyer, newBuyer, data }) => {
    const other = await newBuyer();
    const theirs = await orderFor(other, data);
    const summary = await asBuyer.api.dashboard();
    expect(summary.total_orders).toBe(0);
    expect(summary.recent_orders).toEqual([]);
    expect(summary.settled_revenue_cents).toBe(0);
    expect(JSON.stringify(summary)).not.toContain(theirs.order.order_number);
    expect((await asBuyer.api.customers()).map((customer) => customer.id)).toEqual([asBuyer.customer.id]);
  });

  test("a buyer cannot change another customer's order, or their own", async ({ asBuyer, newBuyer, data, db }) => {
    const other = await newBuyer();
    const mine = await orderFor(asBuyer, data);
    const theirs = await orderFor(other, data);
    for (const { order, payment } of [mine, theirs]) {
      const attempts = [
        asBuyer.api.send("PATCH", `/orders/${order.id}/status`, { data: { status: "CANCELLED" } }),
        asBuyer.api.send("POST", `/payments/${payment.id}/settle`),
        asBuyer.api.send("POST", `/orders/${order.id}/payments`, { data: { method_token: "sim_success" }, headers: { "Idempotency-Key": data.unique("key") } }),
      ];
      expect((await Promise.all(attempts)).map((response) => response.status())).toEqual([403, 403, 403]);
      expect((await db.order(order.order_number)).status).toBe("PENDING");
      expect((await db.payments(order.id)).map((row) => row.status)).toEqual(["AUTHORIZED"]);
    }
  });

  test("the seeded buyers are isolated from each other", async ({ loginAs, db }) => {
    const maple = await loginAs({ email: "buyer@mapleridge.example", password: "Buyer!Forge2026" });
    const granite = await loginAs({ email: "buyer@granite.example", password: "Buyer!Forge2026" });
    const mapleOrder = (await maple.api.listOrders({ page_size: 1 })).items[0];
    expect(mapleOrder).toBeDefined();
    expect((await granite.api.send("GET", `/orders/${mapleOrder?.id}`)).status()).toBe(404);
    const [row] = await db.query<{ count: number }>(`SELECT count(*) FROM orders WHERE customer_id = $1`, [maple.user.customer?.id]);
    expect((await maple.api.listOrders({ page_size: 1 })).total).toBe(row?.count);
  });
});
