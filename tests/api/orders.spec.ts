import { expect, test } from "../../framework/fixtures/api";
import { TAX_BPS } from "../../framework/factories/test-data";
import { expectValidationError, readApiError } from "../../framework/helpers/api-client";
import { expectedTotals } from "../../framework/helpers/money";
import type { OrderDetail } from "../../framework/helpers/types";

const MISSING = "00000000-0000-4000-8000-000000000000";

test.describe("order creation", { tag: "@api" }, () => {
  test("a multi-line order has exact totals, takes stock and starts PENDING", async ({ asManager, data }) => {
    const customer = await data.customer();
    const a = await data.product({ priceCents: 1999, stock: { YYZ1: 10 } });
    const b = await data.product({ priceCents: 333, stock: { YYZ1: 10 } });
    const warehouse = await data.warehouse("YYZ1");
    const response = await asManager.api.send("POST", "/orders", {
      data: {
        customer_id: customer.id,
        warehouse_id: warehouse.id,
        notes: "  rush  ",
        items: [
          { product_id: a.id, quantity: 3 },
          { product_id: b.id, quantity: 7 },
        ],
      },
    });
    expect(response.status()).toBe(201);
    const order = (await response.json()) as OrderDetail;
    data.adopt(`release ${order.order_number}`, async () => void (await asManager.api.moveOrder(order.id, "CANCELLED", "cleanup")));

    const totals = expectedTotals([{ quantity: 3, unitPriceCents: 1999 }, { quantity: 7, unitPriceCents: 333 }], TAX_BPS.YYZ1);
    expect(order).toMatchObject({
      status: "PENDING",
      notes: "rush",
      payment_status: null,
      item_count: 2,
      tax_rate_bps: TAX_BPS.YYZ1,
      subtotal_cents: totals.subtotalCents,
      tax_cents: totals.taxCents,
      total_cents: totals.totalCents,
      allowed_transitions: ["CONFIRMED", "CANCELLED"],
      created_by_name: asManager.user.full_name,
    });
    expect(order.order_number).toMatch(/^ORD-\d+$/);
    expect(order.items.map((item) => [item.sku, item.quantity, item.line_total_cents]).sort()).toEqual(
      [[a.sku, 3, 5997], [b.sku, 7, 2331]].sort(),
    );
    expect((await asManager.api.product(a.id)).total_quantity).toBe(7);
    expect(await asManager.api.order(order.id)).toEqual(order);
  });

  test("each warehouse applies its own tax rate, rounding half-up", async ({ data }) => {
    const customer = await data.customer();
    const product = await data.product({ priceCents: 2000, stock: { YUL1: 5, YYC1: 5 } });
    const quebec = await data.order({ customer, warehouse: "YUL1", lines: [{ product, quantity: 1 }] });
    const alberta = await data.order({ customer, warehouse: "YYC1", lines: [{ product, quantity: 1 }] });
    expect(quebec).toMatchObject({ tax_rate_bps: 1498, tax_cents: 300, total_cents: 2300 });
    expect(alberta).toMatchObject({ tax_rate_bps: 500, tax_cents: 100, total_cents: 2100 });
  });

  test("asking for more than the stock is refused with the shortage, and takes nothing", async ({ asManager, data }) => {
    const customer = await data.customer();
    const enough = await data.product({ stock: { YYZ1: 5 } });
    const short = await data.product({ stock: { YYZ1: 2 } });
    const warehouse = await data.warehouse("YYZ1");
    const response = await asManager.api.send("POST", "/orders", {
      data: {
        customer_id: customer.id,
        warehouse_id: warehouse.id,
        items: [
          { product_id: enough.id, quantity: 1 },
          { product_id: short.id, quantity: 3 },
        ],
      },
    });
    const error = await readApiError(response, 409, "INSUFFICIENT_STOCK");
    expect(error.details).toEqual([{ product_id: short.id, sku: short.sku, requested: 3, available: 2 }]);
    expect((await asManager.api.product(enough.id)).total_quantity).toBe(5);
  });

  test("stock in one warehouse cannot fill an order at another", async ({ asManager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YVR1: 50 } });
    const warehouse = await data.warehouse("YYZ1");
    const body = { customer_id: customer.id, warehouse_id: warehouse.id, items: [{ product_id: product.id, quantity: 1 }] };
    await readApiError(await asManager.api.send("POST", "/orders", { data: body }), 409, "INSUFFICIENT_STOCK");
  });

  test("the last unit can only be sold once when orders race", async ({ asManager, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 1 } });
    const warehouse = await data.warehouse("YYZ1");
    const body = { customer_id: customer.id, warehouse_id: warehouse.id, items: [{ product_id: product.id, quantity: 1 }] };
    const responses = await Promise.all(Array.from({ length: 5 }, () => asManager.api.send("POST", "/orders", { data: body })));
    expect(responses.map((response) => response.status()).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(await db.stock(product.id, "YYZ1")).toBe(0);
    expect(await db.countOrdersForCustomer(customer.id)).toBe(1);
  });

  test("unknown or retired references are refused without creating anything", async ({ asManager, data, db }) => {
    const customer = await data.customer();
    const product = await data.product();
    const retired = await data.product();
    await asManager.api.updateProduct(retired.id, { is_active: false });
    const warehouse = await data.warehouse("YYZ1");
    const send = (change: Record<string, unknown>) =>
      asManager.api.send("POST", "/orders", {
        data: { customer_id: customer.id, warehouse_id: warehouse.id, items: [{ product_id: product.id, quantity: 1 }], ...change },
      });
    await readApiError(await send({ customer_id: MISSING }), 422, "INVALID_REFERENCE");
    await readApiError(await send({ warehouse_id: MISSING }), 422, "INVALID_REFERENCE");
    await readApiError(await send({ items: [{ product_id: MISSING, quantity: 1 }] }), 422, "INVALID_REFERENCE");
    const error = await readApiError(await send({ items: [{ product_id: retired.id, quantity: 1 }] }), 422, "INVALID_REFERENCE");
    expect(error.details[0]?.product_id).toBe(retired.id);
    expect(await db.countOrdersForCustomer(customer.id)).toBe(0);
  });

  const invalidOrders: { name: string; change: (productId: string) => Record<string, unknown>; field: string }[] = [
    { name: "no items", change: () => ({ items: [] }), field: "body.items" },
    { name: "more than 50 lines", change: () => ({ items: Array.from({ length: 51 }, (_, index) => ({ product_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, quantity: 1 })) }), field: "body.items" },
    { name: "the same product twice", change: (id) => ({ items: [{ product_id: id, quantity: 1 }, { product_id: id, quantity: 1 }] }), field: "body.items" },
    { name: "quantity 0", change: (id) => ({ items: [{ product_id: id, quantity: 0 }] }), field: "body.items.0.quantity" },
    { name: "a negative quantity", change: (id) => ({ items: [{ product_id: id, quantity: -2 }] }), field: "body.items.0.quantity" },
    { name: "a fractional quantity", change: (id) => ({ items: [{ product_id: id, quantity: 1.5 }] }), field: "body.items.0.quantity" },
    { name: "a quantity sent as a string", change: (id) => ({ items: [{ product_id: id, quantity: "2" }] }), field: "body.items.0.quantity" },
    { name: "a quantity above the maximum", change: (id) => ({ items: [{ product_id: id, quantity: 100_001 }] }), field: "body.items.0.quantity" },
    { name: "a client-supplied total", change: () => ({ total_cents: 1 }), field: "body.total_cents" },
    { name: "a client-supplied unit price", change: (id) => ({ items: [{ product_id: id, quantity: 1, unit_price_cents: 1 }] }), field: "body.items.0.unit_price_cents" },
    { name: "oversized notes", change: () => ({ notes: "x".repeat(1001) }), field: "body.notes" },
    { name: "a malformed customer id", change: () => ({ customer_id: "nope" }), field: "body.customer_id" },
  ];
  for (const { name, change, field } of invalidOrders) {
    test(`creating an order rejects ${name}`, async ({ asManager, data }) => {
      const customer = await data.customer();
      const product = await data.product({ stock: { YYZ1: 5 } });
      const warehouse = await data.warehouse("YYZ1");
      const body = { customer_id: customer.id, warehouse_id: warehouse.id, items: [{ product_id: product.id, quantity: 1 }] };
      await expectValidationError(await asManager.api.send("POST", "/orders", { data: { ...body, ...change(product.id) } }), field);
      expect((await asManager.api.product(product.id)).total_quantity).toBe(5);
    });
  }

  test("creating an order reports every missing required field", async ({ asManager }) => {
    await expectValidationError(await asManager.api.send("POST", "/orders", { data: {} }), "body.customer_id", "body.warehouse_id", "body.items");
  });

  test("an unknown order is 404 and a malformed id is 422", async ({ asManager }) => {
    await readApiError(await asManager.api.send("GET", `/orders/${MISSING}`), 404, "NOT_FOUND");
    await readApiError(await asManager.api.send("GET", `/orders/${MISSING}/history`), 404, "NOT_FOUND");
    await readApiError(await asManager.api.send("GET", `/orders/${MISSING}/payments`), 404, "NOT_FOUND");
    await readApiError(await asManager.api.send("PATCH", `/orders/${MISSING}/status`, { data: { status: "CANCELLED" } }), 404, "NOT_FOUND");
    await expectValidationError(await asManager.api.send("GET", "/orders/123"), "path.order_id");
  });
});

test.describe("order state transitions", { tag: "@api" }, () => {
  test("the full lifecycle follows the state machine and is recorded in history", async ({ asManager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const payment = await data.pay(order);

    const confirmed = await asManager.api.moveOrder(order.id, "CONFIRMED", "paid");
    expect(confirmed).toMatchObject({ status: "CONFIRMED", payment_status: "AUTHORIZED", allowed_transitions: ["SHIPPED", "CANCELLED"] });
    await asManager.api.settle(payment.id);
    const shipped = await asManager.api.moveOrder(order.id, "SHIPPED");
    expect(shipped).toMatchObject({ status: "SHIPPED", payment_status: "SETTLED", allowed_transitions: ["DELIVERED"] });
    const delivered = await asManager.api.moveOrder(order.id, "DELIVERED");
    expect(delivered).toMatchObject({ status: "DELIVERED", allowed_transitions: [] });

    const history = await asManager.api.orderHistory(order.id);
    expect(history.map((entry) => entry.action)).toEqual([
      "order.created",
      "payment.authorized",
      "order.status_changed",
      "payment.settled",
      "order.status_changed",
      "order.status_changed",
    ]);
    expect(history[2]?.details).toEqual({ from: "PENDING", to: "CONFIRMED", note: "paid" });
    expect(history[2]?.actor_name).toBe(asManager.user.full_name);
  });

  test("rules that depend on payment are enforced", async ({ asManager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const move = (status: string) => asManager.api.send("PATCH", `/orders/${order.id}/status`, { data: { status } });

    await readApiError(await move("CONFIRMED"), 409, "PAYMENT_REQUIRED");
    await data.pay(order, "sim_declined");
    await readApiError(await move("CONFIRMED"), 409, "PAYMENT_REQUIRED");
    const payment = await data.pay(order);
    expect((await move("CONFIRMED")).status()).toBe(200);
    await readApiError(await move("SHIPPED"), 409, "PAYMENT_NOT_SETTLED");
    await asManager.api.settle(payment.id);
    await readApiError(await move("CANCELLED"), 409, "REFUND_NOT_SUPPORTED");
  });

  const invalidMoves: { from: "PENDING" | "CONFIRMED" | "SHIPPED" | "DELIVERED" | "CANCELLED"; to: string }[] = [
    { from: "PENDING", to: "SHIPPED" },
    { from: "PENDING", to: "DELIVERED" },
    { from: "CONFIRMED", to: "DELIVERED" },
    { from: "SHIPPED", to: "CANCELLED" },
    { from: "DELIVERED", to: "CANCELLED" },
    { from: "CANCELLED", to: "CONFIRMED" },
  ];
  for (const { from, to } of invalidMoves) {
    test(`${from} cannot move to ${to}`, async ({ asManager, data }) => {
      const customer = await data.customer();
      const product = await data.product({ stock: { YYZ1: 5 } });
      const order = await data.advance(await data.order({ customer, lines: [{ product, quantity: 1 }] }), from);
      const error = await readApiError(await asManager.api.send("PATCH", `/orders/${order.id}/status`, { data: { status: to } }), 409, "INVALID_TRANSITION");
      expect(error.details[0]).toMatchObject({ from, to });
      expect((await asManager.api.order(order.id)).status).toBe(from);
    });
  }

  test("cancelling returns stock and voids an authorized payment", async ({ asManager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 2 }] });
    const payment = await data.pay(order);
    expect((await asManager.api.product(product.id)).total_quantity).toBe(3);
    const cancelled = await asManager.api.moveOrder(order.id, "CANCELLED", "changed mind");
    expect(cancelled).toMatchObject({ status: "CANCELLED", payment_status: "VOIDED", allowed_transitions: [] });
    expect((await asManager.api.product(product.id)).total_quantity).toBe(5);
    const voided = await asManager.api.payment(payment.id);
    expect(voided.status).toBe("VOIDED");
    expect(voided.voided_at).not.toBeNull();
  });

  test("a status update validates its payload", async ({ asManager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const move = (body: unknown) => asManager.api.send("PATCH", `/orders/${order.id}/status`, { data: body });
    await expectValidationError(await move({ status: "ARCHIVED" }), "body.status");
    await expectValidationError(await move({}), "body.status");
    await expectValidationError(await move({ status: "CANCELLED", note: "x".repeat(501) }), "body.note");
    await expectValidationError(await move({ status: "CANCELLED", total_cents: 0 }), "body.total_cents");
    expect((await asManager.api.order(order.id)).status).toBe("PENDING");
  });
});

test.describe("order listing", { tag: "@api" }, () => {
  test("filters by customer, status, warehouse and order number", async ({ asManager, data }) => {
    const customer = await data.customer();
    const other = await data.customer();
    const product = await data.product({ stock: { YYZ1: 20, YVR1: 20 } });
    const first = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const second = await data.order({ customer, warehouse: "YVR1", lines: [{ product, quantity: 1 }] });
    await data.order({ customer: other, lines: [{ product, quantity: 1 }] });
    await asManager.api.moveOrder(second.id, "CANCELLED");
    const numbers = async (params: Record<string, string>) =>
      (await asManager.api.listOrders({ customer_id: customer.id, ...params })).items.map((order) => order.order_number);

    expect((await numbers({})).sort()).toEqual([first.order_number, second.order_number].sort());
    expect(await numbers({ status: "PENDING" })).toEqual([first.order_number]);
    expect(await numbers({ status: "CANCELLED" })).toEqual([second.order_number]);
    expect(await numbers({ warehouse_id: (await data.warehouse("YVR1")).id })).toEqual([second.order_number]);
    expect(await numbers({ q: first.order_number.toLowerCase() })).toEqual([first.order_number]);
  });

  test("date filters are inclusive whole UTC days", async ({ asManager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const day = order.created_at.slice(0, 10);
    const count = async (params: Record<string, string>) => (await asManager.api.listOrders({ customer_id: customer.id, ...params })).total;
    expect(await count({ date_from: day, date_to: day })).toBe(1);
    expect(await count({ date_from: "2000-01-01", date_to: "2000-01-02" })).toBe(0);
    expect(await count({ date_from: "2999-01-01" })).toBe(0);
  });

  test("the widest possible date range works", async ({ asManager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const params = { customer_id: customer.id, date_from: "0001-01-01", date_to: "9999-12-31" };
    expect((await asManager.api.listOrders(params)).total).toBe(1);
    expect((await asManager.api.send("GET", "/orders/export.csv", { params })).status()).toBe(200);
  });

  test("sorting and pagination are stable and exact", async ({ asManager, data }) => {
    const customer = await data.customer();
    const created = [];
    for (const priceCents of [500, 9000, 2500, 100, 700]) {
      const product = await data.product({ priceCents, stock: { YYZ1: 1 } });
      created.push(await data.order({ customer, lines: [{ product, quantity: 1 }] }));
    }
    const expected = created.map((order) => order.total_cents).sort((a, b) => a - b);
    const page = (number: number) => asManager.api.listOrders({ customer_id: customer.id, sort: "total_cents", direction: "asc", page: number, page_size: 2 });
    const pages = [await page(1), await page(2), await page(3)];
    expect(pages[0]).toMatchObject({ total: 5, pages: 3, page_size: 2 });
    expect(pages.flatMap((item) => item.items.map((order) => order.total_cents))).toEqual(expected);
    expect((await asManager.api.listOrders({ customer_id: customer.id, sort: "total_cents", direction: "desc", page_size: 1 })).items[0]?.total_cents).toBe(expected.at(-1));
  });

  const invalid: { name: string; params: Record<string, string | number>; field: string }[] = [
    { name: "an unknown status", params: { status: "LOST" }, field: "query.status" },
    { name: "a malformed date", params: { date_from: "2026-13-40" }, field: "query.date_from" },
    { name: "a malformed customer id", params: { customer_id: "x" }, field: "query.customer_id" },
    { name: "an unknown sort column", params: { sort: "customer_id" }, field: "query.sort" },
    { name: "page_size 101", params: { page_size: 101 }, field: "query.page_size" },
    { name: "an oversized search", params: { q: "x".repeat(41) }, field: "query.q" },
  ];
  for (const { name, params, field } of invalid) {
    test(`listing orders rejects ${name}`, async ({ asViewer }) => {
      await expectValidationError(await asViewer.api.send("GET", "/orders", { params }), field);
    });
  }

  test("a reversed date range is refused", async ({ asViewer }) => {
    const response = await asViewer.api.send("GET", "/orders", { params: { date_from: "2026-02-02", date_to: "2026-02-01" } });
    await expectValidationError(response, "query.date_from");
  });
});
