import type { APIResponse } from "@playwright/test";
import { expect, test } from "../../framework/fixtures/api";
import type { TestData } from "../../framework/factories/test-data";
import { expectValidationError, readApiError, type ApiClient } from "../../framework/helpers/api-client";
import type { OrderDetail, Payment } from "../../framework/helpers/types";

async function newOrder(data: TestData): Promise<OrderDetail> {
  const customer = await data.customer();
  const product = await data.product({ priceCents: 1234, stock: { YYZ1: 5 } });
  return data.order({ customer, lines: [{ product, quantity: 2 }] });
}

function pay(api: ApiClient, orderId: string, key: string, token = "sim_success"): Promise<APIResponse> {
  return api.send("POST", `/orders/${orderId}/payments`, { data: { method_token: token }, headers: { "Idempotency-Key": key } });
}

test.describe("simulated payments", { tag: "@api" }, () => {
  const outcomes: { token: string; status: string; reason: string | null; authorized: boolean }[] = [
    { token: "sim_success", status: "AUTHORIZED", reason: null, authorized: true },
    { token: "sim_declined", status: "DECLINED", reason: "SIMULATED_ISSUER_DECLINE", authorized: false },
    { token: "sim_timeout", status: "TIMED_OUT", reason: "SIMULATED_GATEWAY_TIMEOUT", authorized: false },
  ];
  for (const { token, status, reason, authorized } of outcomes) {
    test(`${token} is recorded as ${status}, for the server-side order total`, async ({ asManager, data }) => {
      const order = await newOrder(data);
      const response = await pay(asManager.api, order.id, data.unique("key"), token);
      expect(response.status()).toBe(201);
      const payment = (await response.json()) as Payment;
      expect(payment).toMatchObject({ order_id: order.id, status, failure_reason: reason, amount_cents: order.total_cents, method_token: token });
      expect(payment.authorized_at !== null).toBe(authorized);
      const after = await asManager.api.order(order.id);
      expect(after).toMatchObject({ status: "PENDING", payment_status: status });
      expect(await asManager.api.payment(payment.id)).toEqual(payment);
      expect(await asManager.api.orderPayments(order.id)).toEqual([payment]);
    });
  }

  test("a failed attempt can be retried with a new key, and the history keeps both", async ({ asManager, data }) => {
    const order = await newOrder(data);
    await pay(asManager.api, order.id, data.unique("key"), "sim_declined");
    await pay(asManager.api, order.id, data.unique("key"), "sim_timeout");
    const retry = await pay(asManager.api, order.id, data.unique("key"));
    expect(retry.status()).toBe(201);
    const payments = await asManager.api.orderPayments(order.id);
    expect(payments.map((payment) => payment.status)).toEqual(["DECLINED", "TIMED_OUT", "AUTHORIZED"]);
  });

  test("replaying a request returns the original payment and creates nothing", async ({ asManager, data, db }) => {
    const order = await newOrder(data);
    const key = data.unique("key");
    const first = await pay(asManager.api, order.id, key);
    const second = await pay(asManager.api, order.id, key);
    expect(first.status()).toBe(201);
    expect(first.headers()["idempotency-replayed"]).toBeUndefined();
    expect(second.status()).toBe(200);
    expect(second.headers()["idempotency-replayed"]).toBe("true");
    expect(await second.json()).toEqual(await first.json());
    expect(await db.payments(order.id)).toHaveLength(1);
  });

  test("replaying a decline stays a decline", async ({ asManager, data }) => {
    const order = await newOrder(data);
    const key = data.unique("key");
    await pay(asManager.api, order.id, key, "sim_declined");
    const replay = await pay(asManager.api, order.id, key, "sim_declined");
    expect(replay.status()).toBe(200);
    expect(((await replay.json()) as Payment).status).toBe("DECLINED");
  });

  test("simultaneous requests with one key create exactly one payment", async ({ asManager, data, db }) => {
    const order = await newOrder(data);
    const key = data.unique("key");
    const responses = await Promise.all(Array.from({ length: 8 }, () => pay(asManager.api, order.id, key)));
    expect(responses.map((response) => response.status()).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    const ids = await Promise.all(responses.map(async (response) => ((await response.json()) as Payment).id));
    expect(new Set(ids).size).toBe(1);
    expect(await db.payments(order.id)).toHaveLength(1);
  });

  test("simultaneous requests with different keys authorize only once", async ({ asManager, data, db }) => {
    const order = await newOrder(data);
    const responses = await Promise.all(Array.from({ length: 6 }, () => pay(asManager.api, order.id, data.unique("key"))));
    expect(responses.map((response) => response.status()).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    await Promise.all(
      responses.filter((response) => !response.ok()).map((response) => readApiError(response, 409, "ALREADY_PAID")),
    );
    expect(await db.payments(order.id)).toHaveLength(1);
  });

  test("a key cannot be reused for a different token or a different order", async ({ asManager, data }) => {
    const [order, other] = [await newOrder(data), await newOrder(data)];
    const key = data.unique("key");
    await pay(asManager.api, order.id, key);
    await readApiError(await pay(asManager.api, order.id, key, "sim_declined"), 409, "IDEMPOTENCY_KEY_REUSED");
    await readApiError(await pay(asManager.api, other.id, key), 409, "IDEMPOTENCY_KEY_REUSED");
  });

  test("an order cannot be paid twice, or after it is cancelled", async ({ asManager, data }) => {
    const order = await newOrder(data);
    await pay(asManager.api, order.id, data.unique("key"));
    await readApiError(await pay(asManager.api, order.id, data.unique("key")), 409, "ALREADY_PAID");
    await asManager.api.moveOrder(order.id, "CANCELLED");
    await readApiError(await pay(asManager.api, order.id, data.unique("key")), 409, "ORDER_NOT_PAYABLE");
  });

  test("settlement only applies to an authorized payment, once", async ({ asManager, data }) => {
    const order = await newOrder(data);
    const declined = (await (await pay(asManager.api, order.id, data.unique("key"), "sim_declined")).json()) as Payment;
    await readApiError(await asManager.api.send("POST", `/payments/${declined.id}/settle`), 409, "INVALID_PAYMENT_STATE");
    const approved = (await (await pay(asManager.api, order.id, data.unique("key"))).json()) as Payment;
    const settled = await asManager.api.settle(approved.id);
    expect(settled.status).toBe("SETTLED");
    expect(settled.settled_at).not.toBeNull();
    await readApiError(await asManager.api.send("POST", `/payments/${approved.id}/settle`), 409, "INVALID_PAYMENT_STATE");
  });

  const invalidKeys: { name: string; key: string }[] = [
    { name: "too short", key: "short" },
    { name: "too long", key: "k".repeat(129) },
    { name: "containing spaces", key: "has spaces in it" },
    { name: "containing SQL", key: "x'; DROP TABLE payments;--" },
  ];
  for (const { name, key } of invalidKeys) {
    test(`an idempotency key ${name} is rejected`, async ({ asManager, data, db }) => {
      const order = await newOrder(data);
      await expectValidationError(await pay(asManager.api, order.id, key), "header.idempotency-key");
      expect(await db.payments(order.id)).toEqual([]);
    });
  }

  test("a payment needs a key and an allowed simulated token, and accepts no card data", async ({ asManager, data, db }) => {
    const order = await newOrder(data);
    const path = `/orders/${order.id}/payments`;
    const headers = { "Idempotency-Key": data.unique("key") };
    await expectValidationError(await asManager.api.send("POST", path, { data: { method_token: "sim_success" } }), "header.idempotency-key");
    await expectValidationError(await asManager.api.send("POST", path, { data: {}, headers }), "body.method_token");
    await expectValidationError(await asManager.api.send("POST", path, { data: { method_token: "tok_live_real" }, headers }), "body.method_token");
    const card = { method_token: "sim_success", card_number: "4242424242424242" };
    const response = await asManager.api.send("POST", path, { data: card, headers });
    await expectValidationError(response, "body.card_number");
    expect(await response.text()).not.toContain("4242424242424242");
    const amount = { method_token: "sim_success", amount_cents: 1 };
    await expectValidationError(await asManager.api.send("POST", path, { data: amount, headers }), "body.amount_cents");
    expect(await db.payments(order.id)).toEqual([]);
  });

  test("unknown orders and payments are 404", async ({ asManager, data }) => {
    const missing = "00000000-0000-4000-8000-000000000000";
    await readApiError(await pay(asManager.api, missing, data.unique("key")), 404, "NOT_FOUND");
    await readApiError(await asManager.api.send("GET", `/payments/${missing}`), 404, "NOT_FOUND");
    await readApiError(await asManager.api.send("POST", `/payments/${missing}/settle`), 404, "NOT_FOUND");
    await expectValidationError(await asManager.api.send("GET", "/payments/abc"), "path.payment_id");
  });
});
