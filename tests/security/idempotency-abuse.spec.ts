import type { APIResponse } from "@playwright/test";
import { expect, test } from "../../framework/fixtures/api";
import type { TestData } from "../../framework/factories/test-data";
import { readApiError, type ApiClient } from "../../framework/helpers/api-client";
import type { OrderDetail, Payment } from "../../framework/helpers/types";

async function newOrder(data: TestData): Promise<OrderDetail> {
  const customer = await data.customer();
  const product = await data.product({ priceCents: 1000, stock: { YYZ1: 5 } });
  return data.order({ customer, lines: [{ product, quantity: 1 }] });
}

function pay(api: ApiClient, orderId: string, key: string, token = "sim_success"): Promise<APIResponse> {
  return api.send("POST", `/orders/${orderId}/payments`, { data: { method_token: token }, headers: { "Idempotency-Key": key } });
}

test.describe("payment idempotency abuse", { tag: "@security" }, () => {
  test("another user's key does not return that user's payment", async ({ asManager, asAdmin, data, db }) => {
    const order = await newOrder(data);
    const key = data.unique("key");
    expect((await pay(asManager.api, order.id, key)).status()).toBe(201);
    await readApiError(await pay(asAdmin.api, order.id, key), 409, "ALREADY_PAID");
    expect(await db.payments(order.id)).toHaveLength(1);
  });

  test("keys are scoped per user, so the same key elsewhere is an independent payment", async ({ asManager, asAdmin, data }) => {
    const key = data.unique("key");
    const [first, second] = [await newOrder(data), await newOrder(data)];
    const mine = (await (await pay(asManager.api, first.id, key)).json()) as Payment;
    const response = await pay(asAdmin.api, second.id, key);
    expect(response.status()).toBe(201);
    expect(((await response.json()) as Payment).id).not.toBe(mine.id);
  });

  test("a replay cannot turn a decline into an approval", async ({ asManager, data, db }) => {
    const order = await newOrder(data);
    const key = data.unique("key");
    await pay(asManager.api, order.id, key, "sim_declined");
    await readApiError(await pay(asManager.api, order.id, key, "sim_success"), 409, "IDEMPOTENCY_KEY_REUSED");
    expect((await db.payments(order.id)).map((row) => row.status)).toEqual(["DECLINED"]);
  });

  test("a key cannot be moved to a more expensive or cheaper order", async ({ asManager, data, db }) => {
    const [order, other] = [await newOrder(data), await newOrder(data)];
    const key = data.unique("key");
    await pay(asManager.api, order.id, key);
    await readApiError(await pay(asManager.api, other.id, key), 409, "IDEMPOTENCY_KEY_REUSED");
    expect(await db.payments(other.id)).toEqual([]);
  });

  test("a replay after cancellation returns the original record, and does not re-authorize", async ({ asManager, data, db }) => {
    const order = await newOrder(data);
    const key = data.unique("key");
    await pay(asManager.api, order.id, key);
    await asManager.api.moveOrder(order.id, "CANCELLED");
    const replay = await pay(asManager.api, order.id, key);
    expect(replay.status()).toBe(200);
    expect(((await replay.json()) as Payment).status).toBe("VOIDED");
    expect((await db.payments(order.id)).map((row) => row.status)).toEqual(["VOIDED"]);
  });

  test("a price change does not alter what a replay reports", async ({ asManager, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ priceCents: 1000, stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const key = data.unique("key");
    const original = (await (await pay(asManager.api, order.id, key)).json()) as Payment;
    await asManager.api.updateProduct(product.id, { unit_price_cents: 1 });
    expect(((await (await pay(asManager.api, order.id, key)).json()) as Payment).amount_cents).toBe(original.amount_cents);
    expect((await db.payments(order.id))[0]?.amount_cents).toBe(order.total_cents);
  });

  test("racing the same key with different tokens yields one payment and refuses the rest", async ({ asManager, data, db }) => {
    const order = await newOrder(data);
    const key = data.unique("key");
    const tokens = ["sim_success", "sim_declined", "sim_success", "sim_declined", "sim_success", "sim_declined"];
    const responses = await Promise.all(tokens.map((token) => pay(asManager.api, order.id, key, token)));
    const rows = await db.payments(order.id);
    expect(rows).toHaveLength(1);
    expect(responses.filter((response) => response.status() === 201)).toHaveLength(1);
    const statuses = responses.map((response) => response.status());
    expect(statuses.every((status) => [200, 201, 409].includes(status)), statuses.join()).toBe(true);
    expect(statuses.filter((status) => status === 409)).toHaveLength(3);
  });

  test("racing one key across orders creates one payment", async ({ asManager, data, db }) => {
    const orders = [await newOrder(data), await newOrder(data), await newOrder(data), await newOrder(data)];
    const key = data.unique("key");
    const responses = await Promise.all(orders.map((order) => pay(asManager.api, order.id, key)));
    expect(responses.map((response) => response.status()).sort()).toEqual([201, 409, 409, 409]);
    const [row] = await db.query<{ count: number }>(`SELECT count(*) FROM payments WHERE order_id = ANY($1::uuid[])`, [orders.map((order) => order.id)]);
    expect(row?.count).toBe(1);
  });

  test("a deactivated user cannot replay", async ({ loginAs, setupApi, data }) => {
    const user = await data.user("MANAGER");
    const session = await loginAs(user);
    const order = await newOrder(data);
    const key = data.unique("key");
    expect((await pay(session.api, order.id, key)).status()).toBe(201);
    await setupApi.updateUser(user.user.id, { is_active: false });
    await readApiError(await pay(session.api, order.id, key), 401, "INVALID_SESSION");
  });

  test("a client cannot set the amount, status or owner of a payment", async ({ asManager, data, db }) => {
    const order = await newOrder(data);
    for (const extra of [{ amount_cents: 1 }, { status: "SETTLED" }, { created_by_id: order.id }, { order_id: order.id }]) {
      const response = await asManager.api.send("POST", `/orders/${order.id}/payments`, {
        data: { method_token: "sim_success", ...extra },
        headers: { "Idempotency-Key": data.unique("key") },
      });
      await readApiError(response, 422, "VALIDATION_ERROR");
    }
    expect(await db.payments(order.id)).toEqual([]);
  });
});
