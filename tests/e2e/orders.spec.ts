import { TAX_BPS } from "../../framework/factories/test-data";
import { expect, test } from "../../framework/fixtures";
import { centsToDecimal, expectedTotals, parseMoney } from "../../framework/helpers/money";
import { expectApiError } from "../../framework/helpers/api-client";
import { csvHeader, parseCsv } from "../../framework/helpers/csv";
import type { OrderDetail } from "../../framework/helpers/types";

const utcDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

test.describe("order creation", { tag: "@regression" }, () => {
  test("a multi-line order has correct totals in the UI, API and database, and takes stock", { tag: ["@smoke", "@critical"] }, async ({ manager, data, db }) => {
    const customer = await data.customer();
    const drill = await data.product({ priceCents: 14999, stock: { YYZ1: 40, YYC1: 40 } });
    const bolts = await data.product({ priceCents: 1849, stock: { YYZ1: 30 } });
    const expected = expectedTotals(
      [
        { quantity: 3, unitPriceCents: 14999 },
        { quantity: 7, unitPriceCents: 1849 },
      ],
      TAX_BPS.YYZ1,
    );
    expect(expected).toEqual({ subtotalCents: 57940, taxCents: 7532, totalCents: 65472 });

    const { app, api } = manager;
    await app.newOrder.goto();
    await app.newOrder.selectCustomer(customer.name);
    await app.newOrder.selectWarehouse("YYZ1");
    await app.newOrder.setLine(1, drill.sku, 3);
    await app.newOrder.addLine();
    await app.newOrder.setLine(2, bolts.sku, 7);
    expect(await app.newOrder.previewTotals()).toEqual(expected);

    const response = await app.newOrder.submit();
    expect(response.status()).toBe(201);
    const created = (await response.json()) as OrderDetail;

    await expect(app.orderDetails.orderNumber).toHaveText(created.order_number);
    await expect(app.orderDetails.status).toHaveText("Pending");
    await expect(app.orderDetails.items).toHaveCount(2);
    expect(await app.orderDetails.totals()).toEqual(expected);
    await app.orderDetails.toasts.expectSuccess(`Order ${created.order_number} created`);

    const fromApi = await api.order(created.id);
    expect(fromApi).toMatchObject({
      subtotal_cents: expected.subtotalCents,
      tax_cents: expected.taxCents,
      total_cents: expected.totalCents,
    });

    const row = await db.order(created.order_number);
    expect(row).toMatchObject({
      subtotal_cents: expected.subtotalCents,
      tax_cents: expected.taxCents,
      total_cents: expected.totalCents,
      tax_rate_bps: TAX_BPS.YYZ1,
      created_by_email: "manager@testforge.example",
    });
    const items = await db.orderItems(created.id);
    expect(items.map((item) => [item.sku, item.quantity, item.line_total_cents]).sort()).toEqual(
      [
        [drill.sku, 3, 44997],
        [bolts.sku, 7, 12943],
      ].sort(),
    );

    // Stock leaves only the warehouse that fulfils the order.
    expect(await db.stock(drill.id, "YYZ1")).toBe(37);
    expect(await db.stock(drill.id, "YYC1")).toBe(40);
    expect(await db.stock(bolts.id, "YYZ1")).toBe(23);

    const audit = await db.audit(created.id, "order.created");
    expect(audit[0]).toMatchObject({ actor_email: "manager@testforge.example" });
    expect(audit[0]?.details.total_cents).toBe(expected.totalCents);
  });

  test("tax follows the fulfilling warehouse's rate", async ({ manager, data, db }) => {
    const customer = await data.customer();
    // 20.00 at 14.98% is 2.996, so this also proves tax rounds up rather than truncating.
    const product = await data.product({ priceCents: 2000, stock: { YUL1: 10 } });
    const { app } = manager;
    await app.newOrder.goto();
    await app.newOrder.selectCustomer(customer.name);
    await app.newOrder.selectWarehouse("YUL1");
    await app.newOrder.setLine(1, product.sku, 1);
    const expected = expectedTotals([{ quantity: 1, unitPriceCents: 2000 }], TAX_BPS.YUL1);
    expect(expected.taxCents).toBe(300);
    expect(await app.newOrder.previewTotals()).toEqual(expected);
    const created = (await (await app.newOrder.submit()).json()) as OrderDetail;
    expect((await db.order(created.order_number)).total_cents).toBe(expected.totalCents);
  });

  test("validation errors disappear as soon as each field is corrected", { tag: "@critical" }, async ({ manager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const { app } = manager;
    const customerError = app.page.getByText("Choose a customer", { exact: true });
    const warehouseError = app.page.getByText("Choose a warehouse", { exact: true });
    const productError = app.page.getByText("Choose a product", { exact: true });
    const stockError = app.page.getByText("Only 5 available at this warehouse");

    await app.newOrder.goto();
    await app.newOrder.submitButton.click();
    await expect(customerError).toBeVisible();
    await expect(warehouseError).toBeVisible();
    await expect(productError).toBeVisible();
    await expect(app.newOrder.customer).toHaveAttribute("aria-invalid", "true");

    await app.newOrder.selectCustomer(customer.name);
    await expect(customerError).toBeHidden();
    await expect(app.newOrder.customer).not.toHaveAttribute("aria-invalid", "true");
    await expect(warehouseError).toBeVisible();

    await app.newOrder.selectWarehouse("YYZ1");
    await expect(warehouseError).toBeHidden();

    await app.newOrder.setLine(1, product.sku, 6);
    await expect(productError).toBeHidden();
    await expect(stockError).toBeVisible();

    await app.newOrder.quantity(1).fill("5");
    await expect(stockError).toBeHidden();
    expect((await app.newOrder.submit()).status()).toBe(201);
  });

  test("stock taken by someone else while the form is open is rejected, and nothing is saved", { tag: "@critical" }, async ({ manager, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ priceCents: 500, stock: { YYZ1: 5 } });
    const { app } = manager;
    await app.newOrder.goto();
    await app.newOrder.selectCustomer(customer.name);
    await app.newOrder.selectWarehouse("YYZ1");
    await app.newOrder.setLine(1, product.sku, 5);

    // Another user buys 3 of the 5 after this form has loaded its stock levels.
    const rival = await data.order({ customer, lines: [{ product, quantity: 3 }] });

    const response = await app.newOrder.submit();
    expect(response.status()).toBe(409);
    await expect(app.newOrder.error).toContainText("Not enough stock at YYZ1");
    await expect(app.newOrder.error).toContainText(`${product.sku}: requested 5, available 2`);

    expect(await db.stock(product.id, "YYZ1")).toBe(2);
    expect(await db.countOrdersForCustomer(customer.id)).toBe(1);
    expect((await db.order(rival.order_number)).status).toBe("PENDING");
    await expect(app.page.getByText("Only 2 available at this warehouse")).toBeVisible();
  });

  test("two buyers racing for the last units cannot oversell", { tag: "@critical" }, async ({ manager, admin, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYC1: 4 } });
    for (const { app } of [manager, admin]) {
      await app.newOrder.goto();
      await app.newOrder.selectCustomer(customer.name);
      await app.newOrder.selectWarehouse("YYC1");
      await app.newOrder.setLine(1, product.sku, 3);
    }
    const responses = await Promise.all([manager.app.newOrder.submit(), admin.app.newOrder.submit()]);
    expect(responses.map((response) => response.status()).sort()).toEqual([201, 409]);
    expect(await db.stock(product.id, "YYC1")).toBe(1);
    expect(await db.countOrdersForCustomer(customer.id)).toBe(1);
  });

  test("the order form offers a product even when the catalog is larger than one API page", async ({ manager, data }) => {
    // Regression: the form used to load only the first 100 stock rows, silently hiding the rest.
    const fillers = [];
    for (let i = 0; i < 101; i++) fillers.push(data.product({ stock: {} }));
    await Promise.all(fillers);
    // One page holds 100 rows, plus the placeholder option. More than that proves all pages loaded.
    const customer = await data.customer();
    const last = await data.product({ stock: { YVR1: 3 } });
    const { app } = manager;
    await app.newOrder.goto();
    await app.newOrder.selectCustomer(customer.name);
    await app.newOrder.selectWarehouse("YVR1");
    await expect(app.newOrder.product(1).locator("option", { hasText: last.sku })).toBeAttached();
    expect(await app.newOrder.product(1).locator("option").count()).toBeGreaterThan(101);
  });
});

test.describe("order grid", { tag: "@regression" }, () => {
  test("filters by warehouse, status and customer return exactly the matching orders", { tag: "@smoke" }, async ({ manager, data }) => {
    const customer = await data.customer();
    const elsewhere = await data.customer();
    const product = await data.product({ priceCents: 1000, stock: { YYZ1: 50, YYC1: 50 } });
    const toronto = await data.order({ customer, warehouse: "YYZ1", lines: [{ product, quantity: 1 }] });
    const calgary = await data.order({ customer, warehouse: "YYC1", lines: [{ product, quantity: 2 }] });
    const confirmed = await data.advance(await data.order({ customer, lines: [{ product, quantity: 3 }] }), "CONFIRMED");
    await data.order({ customer: elsewhere, lines: [{ product, quantity: 4 }] });

    const { app } = manager;
    const orders = app.orders;
    await orders.goto();
    await orders.filter({ customer: customer.name });
    const numbers = await orders.grid.column("Order");
    await expect(numbers).toHaveText([confirmed.order_number, calgary.order_number, toronto.order_number]);

    await orders.filter({ warehouse: "YYC1" });
    await expect(numbers).toHaveText([calgary.order_number]);
    await expect(await orders.grid.column("Warehouse")).toHaveText(["YYC1"]);

    await orders.selectWarehouse("YYZ1");
    await orders.filter({ status: "CONFIRMED" });
    await expect(numbers).toHaveText([confirmed.order_number]);
    await expect(await orders.grid.column("Status")).toHaveText(["Confirmed"]);
    await expect(await orders.grid.column("Payment")).toHaveText(["Authorized"]);

    await orders.filter({ status: "SHIPPED" });
    await expect(orders.emptyState).toContainText("No orders match these filters");
  });

  test("the date range filter is inclusive and matches the seeded history", { tag: "@smoke" }, async ({ viewer, db }) => {
    // Seeded orders are read here but never changed, and all predate anything tests create.
    const expected = await db.firstSeededDay();
    const { orders } = viewer.app;
    await orders.goto();
    await orders.filter({ dateFrom: expected.day, dateTo: expected.day });
    await expect(await orders.grid.column("Order")).toHaveText(expected.numbers);

    const wider = await db.seededOrderNumbers("2026-02-01", "2026-02-16");
    expect(wider.length).toBeGreaterThan(1);
    await orders.filter({ dateFrom: "2026-02-01", dateTo: "2026-02-15" });
    await expect(await orders.grid.column("Order")).toHaveText(wider);
  });

  test("an order made today is found by today's date and excluded by yesterday's", async ({ manager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { orders } = manager.app;
    await orders.goto();
    await orders.filter({ customer: customer.name, dateFrom: utcDay(), dateTo: utcDay() });
    await expect(await orders.grid.column("Order")).toHaveText([order.order_number]);
    await orders.filter({ dateFrom: utcDay(-2), dateTo: utcDay(-1) });
    await expect(orders.emptyState).toBeVisible();
  });

  test("an inverted date range shows the API's error rather than empty results", async ({ manager }) => {
    const { orders } = manager.app;
    await orders.goto();
    await orders.filter({ dateFrom: "2026-03-01", dateTo: "2026-02-01" });
    await expect(orders.page.getByTestId("error-state")).toContainText("date_from must not be after date_to");
  });

  test("sorting and pagination cover every order exactly once, in the right order", { tag: "@critical" }, async ({ manager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ priceCents: 1000, stock: { YYZ1: 500 } });
    // Quantities are shuffled so creation order differs from total order. 17 is over one 15-row page.
    const quantities = [9, 2, 16, 5, 12, 1, 14, 7, 3, 17, 10, 4, 15, 6, 13, 8, 11];
    const created = [];
    for (const quantity of quantities) {
      created.push(await data.order({ customer, lines: [{ product, quantity }] }));
    }
    const ascending = [...created].sort((a, b) => a.total_cents - b.total_cents).map((order) => order.order_number);

    const { orders } = manager.app;
    await orders.goto();
    await orders.filter({ customer: customer.name });
    await expect(orders.grid.summary).toHaveText("17 orders · page 1 of 2");

    await orders.grid.sortBy("Total", "total_cents", "asc");
    const numbers = await orders.grid.column("Order");
    await expect(numbers).toHaveText(ascending.slice(0, 15));
    const totals = (await (await orders.grid.column("Total")).allInnerTexts()).map(parseMoney);
    expect(totals).toEqual([...totals].sort((a, b) => a - b));

    await orders.grid.nextPage(2);
    await expect(orders.grid.summary).toHaveText("17 orders · page 2 of 2");
    await expect(numbers).toHaveText(ascending.slice(15));
    await expect(orders.page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();

    await orders.grid.previousPage(1);
    await expect(numbers).toHaveText(ascending.slice(0, 15));

    await orders.grid.sortBy("Total", "total_cents", "desc");
    await expect(numbers).toHaveText([...ascending].reverse().slice(0, 15));
  });

  test("rapid typing right after Clear is kept and applied", { tag: "@critical" }, async ({ manager, data }) => {
    // Regression: Clear's URL update commits as a low-priority transition. It could land after the
    // user had started typing, and an effect then blanked the new input.
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 10 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { orders } = manager.app;
    await orders.goto("?status=SHIPPED");
    await expect(orders.status).toHaveValue("SHIPPED");

    await orders.clearAndTypeOrderNumberInSameTask(order.order_number.slice(0, 4));
    await expect(orders.status).toHaveValue("");

    // What was typed survives Clear's update settling. That is the bug this test guards against.
    await expect(orders.q).toHaveValue(order.order_number.slice(0, 4));

    // Then real keystrokes with no delay, followed by a real selection, all apply as entered.
    await orders.q.clear();
    await orders.q.pressSequentially(order.order_number);
    await orders.status.selectOption("PENDING");
    await expect(orders.q).toHaveValue(order.order_number);
    await orders.submitFilters();

    await expect(await orders.grid.column("Order")).toHaveText([order.order_number]);
    await expect(orders.q).toHaveValue(order.order_number);
    await expect(orders.status).toHaveValue("PENDING");
    await expect(orders.page).toHaveURL(new RegExp(`q=${order.order_number}.*status=PENDING`));
  });

  test("the filter form stays correct when going back and forward", async ({ manager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 10 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { orders } = manager.app;
    await orders.goto();
    await orders.filter({ q: order.order_number });
    await expect(orders.grid.rows).toHaveCount(1);
    await orders.filter({ q: "", status: "SHIPPED" });

    await orders.page.goBack();
    await expect(orders.q).toHaveValue(order.order_number);
    await expect(orders.status).toHaveValue("");
    await expect(orders.grid.rows).toHaveCount(1);
  });
});

test.describe("CSV export", { tag: "@regression" }, () => {
  test("the downloaded file contains exactly the filtered orders with exact amounts", { tag: ["@smoke", "@critical"] }, async ({ manager, data, db }) => {
    // Commas and quotes must survive the round trip. The namespace keeps the name unique to this test.
    const customerName = `Acme, "Quoted" Trading ${data.namespace}`;
    const customer = await data.customer(customerName);
    const product = await data.product({ priceCents: 1849, stock: { YYZ1: 50, YYC1: 50 } });
    const first = await data.order({ customer, warehouse: "YYZ1", lines: [{ product, quantity: 3 }] });
    const second = await data.order({ customer, warehouse: "YYC1", lines: [{ product, quantity: 7 }] });
    const paid = await data.advance(first, "SHIPPED");
    const excluded = await data.order({ customer: await data.customer(), lines: [{ product, quantity: 1 }] });

    const { orders } = manager.app;
    await orders.goto();
    await orders.filter({ customer: customer.name });
    await orders.grid.sortBy("Total", "total_cents", "asc");
    const csv = await orders.exportCsv();

    expect(csv.filename).toBe("orders.csv");
    expect(csvHeader(csv.text)).toEqual([
      "order_number",
      "created_at",
      "customer_code",
      "customer_name",
      "warehouse_code",
      "status",
      "payment_status",
      "line_count",
      "subtotal_cents",
      "tax_cents",
      "total_cents",
      "total",
    ]);
    expect(csv.text).not.toContain(excluded.order_number);

    const rows = parseCsv(csv.text);
    expect(rows.map((row) => row.order_number)).toEqual([paid.order_number, second.order_number]);
    for (const row of rows) {
      const stored = await db.order(row.order_number ?? "");
      expect(Number(row.subtotal_cents)).toBe(stored.subtotal_cents);
      expect(Number(row.tax_cents)).toBe(stored.tax_cents);
      expect(Number(row.total_cents)).toBe(stored.total_cents);
      expect(row.total).toBe(centsToDecimal(stored.total_cents));
      expect(row.customer_name).toBe(customerName);
      expect(row.status).toBe(stored.status);
    }
    expect(rows[0]).toMatchObject({ status: "SHIPPED", payment_status: "SETTLED", warehouse_code: "YYZ1" });
    expect(rows[1]).toMatchObject({ status: "PENDING", payment_status: "", warehouse_code: "YYC1" });
    // 3 x 18.49 = 55.47, plus 13% (7.2111 -> 7.21) = 62.68.
    expect(rows[0]?.total).toBe("62.68");

  });

  test("text that a spreadsheet would run as a formula is neutralised", async ({ manager, data }) => {
    const customer = await data.customer(`=HYPERLINK("http://evil.example","${data.namespace}")`);
    const product = await data.product({ stock: { YYZ1: 5 } });
    await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { orders } = manager.app;
    await orders.goto();
    await orders.filter({ customer: customer.name });
    const [row] = parseCsv((await orders.exportCsv()).text);
    expect(row?.customer_name).toBe(`'${customer.name}`);
  });
});

test.describe("order status", { tag: "@regression" }, () => {
  test("the UI offers only valid next steps, and the API rejects the rest", { tag: "@critical" }, async ({ manager, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 10 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { app, api } = manager;

    await app.orderDetails.goto(order.id);
    await expect(app.orderDetails.actions).toHaveText(["Confirm order", "Cancel order"]);
    await expectApiError(await api.send("PATCH", `/orders/${order.id}/status`, { data: { status: "SHIPPED" } }), 409, "INVALID_TRANSITION");
    await expectApiError(await api.send("PATCH", `/orders/${order.id}/status`, { data: { status: "DELIVERED" } }), 409, "INVALID_TRANSITION");
    expect((await db.order(order.order_number)).status).toBe("PENDING");

    await data.advance(order, "DELIVERED");
    await app.orderDetails.goto(order.id);
    await expect(app.orderDetails.status).toHaveText("Delivered");
    await expect(app.orderDetails.actions).toHaveCount(0);
    await expectApiError(await api.send("PATCH", `/orders/${order.id}/status`, { data: { status: "CANCELLED" } }), 409, "INVALID_TRANSITION");
  });

  test("confirming without a payment is refused with the business reason", { tag: "@critical" }, async ({ manager, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 10 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { orderDetails } = manager.app;
    await orderDetails.goto(order.id);
    await orderDetails.attemptTransition("Confirm order");
    await expect(orderDetails.statusError).toContainText("authorized payment is required");
    await orderDetails.statusModal.button("Keep as is").click();
    await expect(orderDetails.status).toHaveText("Pending");
    expect((await db.order(order.order_number)).status).toBe("PENDING");
  });

  test("cancelling returns the stock, voids the authorization and records the note", { tag: "@critical" }, async ({ manager, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 20 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 8 }] });
    await data.pay(order);
    expect(await db.stock(product.id, "YYZ1")).toBe(12);

    const { orderDetails } = manager.app;
    await orderDetails.goto(order.id);
    await orderDetails.transition("Cancel order", "Cancelled", "customer changed their mind");
    await expect(orderDetails.actions).toHaveCount(0);
    await expect(orderDetails.history.filter({ hasText: "customer changed their mind" })).toContainText("Status changed from Pending to Cancelled");

    expect(await db.stock(product.id, "YYZ1")).toBe(20);
    const [payment] = await db.payments(order.id);
    expect(payment?.status).toBe("VOIDED");
    expect(payment?.voided_at).not.toBeNull();
  });
});
