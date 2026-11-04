import { expect, test } from "../../framework/fixtures/api";
import { TAX_BPS } from "../../framework/factories/test-data";
import { readApiError } from "../../framework/helpers/api-client";
import { expectedTotals } from "../../framework/helpers/money";

interface Count {
  count: number;
}

test.describe("orders in the database", { tag: "@database" }, () => {
  test("header and line items hold exactly what the API reported", async ({ data, db }) => {
    const customer = await data.customer();
    const a = await data.product({ priceCents: 1999, stock: { YUL1: 10 } });
    const b = await data.product({ priceCents: 333, stock: { YUL1: 10 } });
    const order = await data.order({ customer, warehouse: "YUL1", lines: [{ product: a, quantity: 3 }, { product: b, quantity: 7 }] });
    const totals = expectedTotals([{ quantity: 3, unitPriceCents: 1999 }, { quantity: 7, unitPriceCents: 333 }], TAX_BPS.YUL1);

    const [header] = await db.query<Record<string, unknown>>(
      `SELECT order_number, status, customer_id, subtotal_cents, tax_rate_bps, tax_cents, total_cents FROM orders WHERE id = $1`,
      [order.id],
    );
    expect(header).toEqual({
      order_number: order.order_number,
      status: "PENDING",
      customer_id: customer.id,
      subtotal_cents: totals.subtotalCents,
      tax_rate_bps: TAX_BPS.YUL1,
      tax_cents: totals.taxCents,
      total_cents: totals.totalCents,
    });
    expect(await db.orderItems(order.id)).toEqual(
      [
        { sku: a.sku, quantity: 3, unit_price_cents: 1999, line_total_cents: 5997 },
        { sku: b.sku, quantity: 7, unit_price_cents: 333, line_total_cents: 2331 },
      ].sort((x, y) => x.sku.localeCompare(y.sku)),
    );
  });

  test("the database computes the same totals as the API, using integer half-up rounding", async ({ data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ priceCents: 2000, stock: { YUL1: 5 } });
    const order = await data.order({ customer, warehouse: "YUL1", lines: [{ product, quantity: 1 }] });
    const [row] = await db.query<{ subtotal: number; tax: number; total_ok: boolean }>(
      `SELECT sum(i.line_total_cents)::bigint AS subtotal,
              ((sum(i.line_total_cents) * o.tax_rate_bps + 5000) / 10000)::bigint AS tax,
              bool_and(o.total_cents = o.subtotal_cents + o.tax_cents) AS total_ok
         FROM orders o JOIN order_items i ON i.order_id = o.id
        WHERE o.id = $1 GROUP BY o.id`,
      [order.id],
    );
    // 2000 at 14.98% is 299.6 cents, a case where truncating would give 299.
    expect(row).toEqual({ subtotal: order.subtotal_cents, tax: 300, total_ok: true });
    expect(order.tax_cents).toBe(300);
  });

  test("no order anywhere has totals that disagree with its lines", async ({ db }) => {
    const bad = await db.query(
      `SELECT o.order_number
         FROM orders o JOIN order_items i ON i.order_id = o.id
        GROUP BY o.id
       HAVING o.subtotal_cents <> sum(i.line_total_cents)
           OR o.tax_cents <> (o.subtotal_cents * o.tax_rate_bps + 5000) / 10000
           OR o.total_cents <> o.subtotal_cents + o.tax_cents`,
    );
    expect(bad).toEqual([]);
    expect(await db.query(`SELECT id FROM order_items WHERE line_total_cents <> quantity * unit_price_cents`)).toEqual([]);
  });

  test("every money column is a 64-bit integer, never a float or decimal", async ({ db }) => {
    const columns = await db.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name LIKE '%\\_cents' ORDER BY 1, 2`,
    );
    expect(columns.length).toBe(7);
    expect(new Set(columns.map((column) => column.data_type))).toEqual(new Set(["bigint"]));
    const floats = await db.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type IN ('real', 'double precision', 'numeric', 'money')`,
    );
    expect(floats).toEqual([]);
  });

  test("an order keeps its price and name after the product changes", async ({ data, db, asManager }) => {
    const customer = await data.customer();
    const product = await data.product({ priceCents: 1000, stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    await asManager.api.updateProduct(product.id, { unit_price_cents: 9999, name: "Renamed" });
    const [item] = await db.query<{ product_name: string; unit_price_cents: number }>(
      `SELECT product_name, unit_price_cents FROM order_items WHERE order_id = $1`,
      [order.id],
    );
    expect(item).toEqual({ product_name: product.name, unit_price_cents: 1000 });
    expect((await db.order(order.order_number)).total_cents).toBe(order.total_cents);
  });
});

test.describe("inventory in the database", { tag: "@database" }, () => {
  async function stockRow(db: { query: <T extends object>(sql: string, params?: unknown[]) => Promise<T[]> }, productId: string) {
    const [row] = await db.query<{ quantity: number; version: number }>(
      `SELECT i.quantity, i.version FROM inventory i JOIN warehouses w ON w.id = i.warehouse_id WHERE i.product_id = $1 AND w.code = 'YYZ1'`,
      [productId],
    );
    return row;
  }

  test("creating and cancelling an order moves stock and version exactly once each", async ({ data, db, asManager }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 10 } });
    const start = await stockRow(db, product.id);
    const order = await data.order({ customer, lines: [{ product, quantity: 4 }] });
    expect(await stockRow(db, product.id)).toEqual({ quantity: (start?.quantity ?? 0) - 4, version: (start?.version ?? 0) + 1 });
    await asManager.api.moveOrder(order.id, "CANCELLED");
    expect(await stockRow(db, product.id)).toEqual({ quantity: start?.quantity, version: (start?.version ?? 0) + 2 });
  });

  test("an order only takes stock from its own warehouse", async ({ data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 10, YVR1: 10 } });
    await data.order({ customer, warehouse: "YVR1", lines: [{ product, quantity: 3 }] });
    expect(await db.stock(product.id, "YVR1")).toBe(7);
    expect(await db.stock(product.id, "YYZ1")).toBe(10);
  });

  test("racing orders end with sold plus remaining equal to the starting stock", async ({ data, db, asManager }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 7 } });
    const warehouse = await data.warehouse("YYZ1");
    const body = { customer_id: customer.id, warehouse_id: warehouse.id, items: [{ product_id: product.id, quantity: 2 }] };
    const responses = await Promise.all(Array.from({ length: 6 }, () => asManager.api.send("POST", "/orders", { data: body })));
    expect(responses.filter((response) => response.status() === 201)).toHaveLength(3);
    expect(responses.filter((response) => response.status() === 409)).toHaveLength(3);
    const [sold] = await db.query<{ sum: number }>(`SELECT coalesce(sum(quantity), 0)::bigint AS sum FROM order_items WHERE product_id = $1`, [product.id]);
    expect(sold?.sum).toBe(6);
    expect(await db.stock(product.id, "YYZ1")).toBe(1);
  });

  test("no inventory row anywhere is negative, and the database constraint exists", async ({ db }) => {
    expect(await db.query(`SELECT id FROM inventory WHERE quantity < 0 OR reorder_level < 0 OR version < 1`)).toEqual([]);
    const checks = await db.query<{ conname: string }>(`SELECT conname FROM pg_constraint WHERE conrelid = 'inventory'::regclass AND contype = 'c'`);
    expect(checks.map((check) => check.conname)).toContain("ck_inventory_quantity_non_negative");
  });
});

test.describe("payments in the database", { tag: "@database" }, () => {
  test("each outcome stores the order total and the right timestamps", async ({ data, db, asManager }) => {
    const customer = await data.customer();
    const product = await data.product({ priceCents: 1234, stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 2 }] });
    await data.pay(order, "sim_declined");
    await data.pay(order, "sim_timeout");
    const approved = await data.pay(order);

    const rows = await db.payments(order.id);
    expect(rows.map((row) => [row.status, row.amount_cents, row.failure_reason])).toEqual([
      ["DECLINED", order.total_cents, "SIMULATED_ISSUER_DECLINE"],
      ["TIMED_OUT", order.total_cents, "SIMULATED_GATEWAY_TIMEOUT"],
      ["AUTHORIZED", order.total_cents, null],
    ]);
    expect(rows.map((row) => row.authorized_at !== null)).toEqual([false, false, true]);

    await asManager.api.settle(approved.id);
    const [settled] = await db.query<{ status: string; settled_at: Date | null; voided_at: Date | null }>(`SELECT status, settled_at, voided_at FROM payments WHERE id = $1`, [approved.id]);
    expect(settled?.status).toBe("SETTLED");
    expect(settled?.settled_at).toBeInstanceOf(Date);
    expect(settled?.voided_at).toBeNull();
  });

  test("a replay leaves one row and one audit record", async ({ data, db, asManager }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const key = data.unique("key");
    const payment = await asManager.api.pay(order.id, "sim_success", key);
    await asManager.api.pay(order.id, "sim_success", key);
    await asManager.api.pay(order.id, "sim_success", key);
    expect(await db.query<Count>(`SELECT count(*) FROM payments WHERE order_id = $1`, [order.id])).toEqual([{ count: 1 }]);
    expect(await db.audit(payment.id, "payment.authorized")).toHaveLength(1);
    const [row] = await db.query<{ idempotency_key: string; created_by_id: string }>(`SELECT idempotency_key, created_by_id FROM payments WHERE id = $1`, [payment.id]);
    expect(row).toEqual({ idempotency_key: key, created_by_id: asManager.user.id });
  });

  test("the database itself enforces key uniqueness and one live payment per order", async ({ db }) => {
    const indexes = await db.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE tablename = 'payments' AND indexdef LIKE 'CREATE UNIQUE%'`);
    const definitions = indexes.map((index) => index.indexdef).join("\n");
    expect(definitions).toMatch(/\(created_by_id, idempotency_key\)/);
    expect(definitions).toMatch(/\(order_id\) WHERE .*AUTHORIZED.*SETTLED/);
  });

  test("across all data, no order has two live payments and timestamps match each status", async ({ db }) => {
    expect(await db.query(`SELECT order_id FROM payments WHERE status IN ('AUTHORIZED', 'SETTLED') GROUP BY 1 HAVING count(*) > 1`)).toEqual([]);
    expect(await db.query(`SELECT id FROM payments WHERE status = 'SETTLED' AND settled_at IS NULL`)).toEqual([]);
    expect(await db.query(`SELECT id FROM payments WHERE status = 'VOIDED' AND voided_at IS NULL`)).toEqual([]);
    expect(await db.query(`SELECT id FROM payments WHERE status IN ('DECLINED', 'TIMED_OUT') AND failure_reason IS NULL`)).toEqual([]);
    expect(await db.query(`SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.amount_cents <> o.total_cents`)).toEqual([]);
  });
});

test.describe("transaction rollback", { tag: "@database" }, () => {
  test("a database failure after stock is taken undoes everything", async ({ loginAs, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 10 } });
    const warehouse = await data.warehouse("YYZ1");
    // A user of its own, so that "this user wrote no audit rows" cannot be disturbed by other workers.
    const manager = await loginAs(await data.user("MANAGER"));
    const before = await db.query(`SELECT quantity, version FROM inventory WHERE product_id = $1 ORDER BY id`, [product.id]);
    // PostgreSQL rejects a NUL byte when the order row is inserted, after the stock update has already gone to the database.
    const response = await manager.api.send("POST", "/orders", {
      data: { customer_id: customer.id, warehouse_id: warehouse.id, notes: "boom\u0000", items: [{ product_id: product.id, quantity: 4 }] },
    });
    await readApiError(response, 422, "INVALID_DATA");
    expect(await db.query(`SELECT quantity, version FROM inventory WHERE product_id = $1 ORDER BY id`, [product.id])).toEqual(before);
    expect(await db.countOrdersForCustomer(customer.id)).toBe(0);
    expect(await db.query(`SELECT 1 FROM order_items WHERE product_id = $1`, [product.id])).toEqual([]);
    expect(await db.query(`SELECT action FROM audit_logs WHERE actor_user_id = $1 AND action <> 'auth.login'`, [manager.user.id])).toEqual([]);
  });

  test("one short line in a multi-line order leaves every line's stock untouched", async ({ asManager, data, db }) => {
    const customer = await data.customer();
    const lines = [await data.product({ stock: { YYZ1: 5 } }), await data.product({ stock: { YYZ1: 5 } }), await data.product({ stock: { YYZ1: 1 } })];
    const warehouse = await data.warehouse("YYZ1");
    const response = await asManager.api.send("POST", "/orders", {
      data: { customer_id: customer.id, warehouse_id: warehouse.id, items: lines.map((product) => ({ product_id: product.id, quantity: 2 })) },
    });
    await readApiError(response, 409, "INSUFFICIENT_STOCK");
    const stock = [];
    for (const product of lines) stock.push(await db.stock(product.id, "YYZ1"));
    expect(stock).toEqual([5, 5, 1]);
    expect(await db.countOrdersForCustomer(customer.id)).toBe(0);
  });

  test("a failed status change leaves the order, payment and audit trail unchanged", async ({ asManager, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const payment = await data.pay(order);
    await asManager.api.settle(payment.id);
    await readApiError(await asManager.api.send("PATCH", `/orders/${order.id}/status`, { data: { status: "CANCELLED" } }), 409, "REFUND_NOT_SUPPORTED");
    expect((await db.order(order.order_number)).status).toBe("PENDING");
    expect((await db.payments(order.id))[0]?.status).toBe("SETTLED");
    expect(await db.stock(product.id, "YYZ1")).toBe(4);
    expect(await db.audit(order.id, "order.status_changed")).toEqual([]);
  });

  test("a stale inventory edit writes no audit record", async ({ asManager, data, db }) => {
    const product = await data.product({ stock: { YYZ1: 5 } });
    const row = product.stock.find((item) => item.warehouse.code === "YYZ1");
    const before = await db.audit(row?.inventory_id ?? "", "inventory.updated");
    await readApiError(
      await asManager.api.send("PATCH", `/inventory/${row?.inventory_id}`, { data: { quantity: 1, expected_version: 1, reason: "stale edit" } }),
      409,
      "VERSION_CONFLICT",
    );
    expect(await db.audit(row?.inventory_id ?? "", "inventory.updated")).toEqual(before);
    expect(await db.stock(product.id, "YYZ1")).toBe(5);
  });
});

test.describe("referential integrity", { tag: "@database" }, () => {
  test("every *_id column has a validated foreign key, except the audit log's polymorphic reference", async ({ db }) => {
    const missing = await db.query<{ table_name: string; column_name: string }>(
      `SELECT c.table_name, c.column_name
         FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.column_name LIKE '%\\_id' AND c.table_name <> 'alembic_version'
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint k
              JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
             WHERE k.contype = 'f' AND k.convalidated
               AND k.conrelid = (quote_ident(c.table_name))::regclass AND a.attname = c.column_name
          )`,
    );
    expect(missing).toEqual([{ table_name: "audit_logs", column_name: "entity_id" }]);
  });

  const orphans: { name: string; sql: string }[] = [
    { name: "order items without an order", sql: `SELECT i.id FROM order_items i LEFT JOIN orders o ON o.id = i.order_id WHERE o.id IS NULL` },
    { name: "order items without a product", sql: `SELECT i.id FROM order_items i LEFT JOIN products p ON p.id = i.product_id WHERE p.id IS NULL` },
    { name: "orders without any line", sql: `SELECT o.id FROM orders o LEFT JOIN order_items i ON i.order_id = o.id WHERE i.id IS NULL` },
    { name: "payments without an order", sql: `SELECT p.id FROM payments p LEFT JOIN orders o ON o.id = p.order_id WHERE o.id IS NULL` },
    { name: "inventory without a warehouse", sql: `SELECT i.id FROM inventory i LEFT JOIN warehouses w ON w.id = i.warehouse_id WHERE w.id IS NULL` },
    { name: "products missing a stock row in some warehouse", sql: `SELECT p.id FROM products p CROSS JOIN warehouses w LEFT JOIN inventory i ON i.product_id = p.id AND i.warehouse_id = w.id WHERE i.id IS NULL` },
    { name: "customer accounts that are not Viewers", sql: `SELECT id FROM users WHERE customer_id IS NOT NULL AND role <> 'VIEWER'` },
    { name: "audit rows for orders that do not exist", sql: `SELECT a.id FROM audit_logs a LEFT JOIN orders o ON o.id::text = a.entity_id WHERE a.entity_type = 'order' AND a.entity_id <> 'export' AND o.id IS NULL` },
  ];
  for (const { name, sql } of orphans) {
    test(`there are no ${name}`, async ({ db }) => {
      expect(await db.query(sql)).toEqual([]);
    });
  }
});

test.describe("audit records", { tag: "@database" }, () => {
  test("each business action records who did it, in the same transaction", async ({ asManager, asAdmin, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ priceCents: 500, stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const payment = await asManager.api.pay(order.id, "sim_success", data.unique("key"));
    await asManager.api.moveOrder(order.id, "CANCELLED", "audit note");
    const row = product.stock.find((item) => item.warehouse.code === "YVR1");
    await asManager.api.adjustInventory(row?.inventory_id ?? "", 9, row?.version ?? 0, "audit check");
    await asManager.api.updateProduct(product.id, { name: "Audited" });
    await asAdmin.api.retireProduct(product.id);

    const adminEmail = "admin@testforge.example";
    const [created] = await db.audit(order.id, "order.created");
    expect(created).toMatchObject({ actor_email: adminEmail, details: { order_number: order.order_number, total_cents: order.total_cents, lines: 1 } });
    expect((await db.audit(payment.id, "payment.authorized"))[0]).toMatchObject({ actor_email: asManager.user.email, details: { order_id: order.id, amount_cents: order.total_cents } });
    expect((await db.audit(payment.id, "payment.voided"))[0]?.actor_email).toBe(asManager.user.email);
    expect((await db.audit(order.id, "order.status_changed"))[0]?.details).toEqual({ from: "PENDING", to: "CANCELLED", note: "audit note" });
    expect((await db.audit(row?.inventory_id ?? "", "inventory.updated")).at(-1)).toMatchObject({ actor_email: asManager.user.email, details: { from: 0, to: 9, reason: "audit check" } });
    expect((await db.audit(product.id, "product.created"))[0]?.details).toEqual({ sku: product.sku });
    expect((await db.audit(product.id, "product.updated"))[0]?.details).toEqual({ name: "Audited" });
    expect((await db.audit(product.id, "product.deactivated"))[0]?.actor_email).toBe(asAdmin.user.email);
  });

  test("user and customer administration is audited", async ({ data, db, setupApi }) => {
    const customer = await data.customer();
    const user = await data.user("VIEWER", customer);
    await setupApi.updateUser(user.user.id, { is_active: false });
    expect((await db.audit(customer.id, "customer.created"))[0]?.details).toEqual({ code: customer.code });
    expect((await db.audit(user.user.id, "user.created"))[0]?.details).toEqual({ role: "VIEWER" });
    expect((await db.audit(user.user.id, "user.updated"))[0]?.details).toEqual({ is_active: "False" });
  });

  test("login, failed login and logout are audited, without the password", async ({ anonymous, loginAs, data, db }) => {
    const created = await data.user("VIEWER");
    const session = await loginAs(created);
    await session.api.logout();
    const wrong = "Wrong-Password-Marker-" + data.namespace;
    expect((await anonymous.send("POST", "/auth/login", { data: { email: created.email, password: wrong } })).status()).toBe(401);

    expect(await db.audit(created.user.id, "auth.login")).toHaveLength(1);
    expect(await db.audit(created.user.id, "auth.logout")).toHaveLength(1);
    expect((await db.audit(created.email, "auth.login_failed"))[0]).toMatchObject({ actor_email: created.email, details: { email: created.email } });
    const leaks = await db.query(`SELECT id FROM audit_logs WHERE details::text LIKE $1 OR details::text LIKE $2`, [`%${wrong}%`, `%${created.password}%`]);
    expect(leaks).toEqual([]);
  });

  test("a failed login with a long email is recorded in full", async ({ anonymous, data, db }) => {
    const email = `${data.namespace.toLowerCase()}-${"a".repeat(50)}@${"b".repeat(60)}.example`;
    expect((await anonymous.send("POST", "/auth/login", { data: { email, password: "wrong-password" } })).status()).toBe(401);
    expect((await db.audit(email.slice(0, 64), "auth.login_failed"))[0]).toMatchObject({ actor_email: null, details: { email } });
  });

  test("an export records how many rows it returned", async ({ asBuyer, data, db }) => {
    const product = await data.product({ stock: { YYZ1: 5 } });
    await data.order({ customer: asBuyer.customer, lines: [{ product, quantity: 1 }] });
    await asBuyer.api.send("GET", "/orders/export.csv");
    const rows = await db.query<{ details: { rows: number } }>(`SELECT details FROM audit_logs WHERE action = 'order.exported' AND actor_user_id = $1`, [asBuyer.user.id]);
    expect(rows.map((row) => row.details.rows)).toEqual([1]);
  });

  test("the audit log API returns what the database holds, filtered by entity", async ({ asAdmin, data }) => {
    const customer = await data.customer();
    const response = await asAdmin.api.send("GET", "/audit-logs", { params: { entity_type: "customer", entity_id: customer.id, action: "customer.created" } });
    const page = (await response.json()) as { total: number; items: { entity_id: string; actor_email: string }[] };
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ entity_id: customer.id, actor_email: asAdmin.user.email });
  });
});

test.describe("customer-scoped data isolation", { tag: "@database" }, () => {
  test("what a buyer can reach through the API is exactly their customer's rows", async ({ asBuyer, newBuyer, data, db }) => {
    const other = await newBuyer();
    const product = await data.product({ stock: { YYZ1: 20 } });
    for (const customer of [asBuyer.customer, asBuyer.customer, other.customer]) {
      await data.order({ customer, lines: [{ product, quantity: 1 }] });
    }
    const inDb = await db.query<{ order_number: string }>(`SELECT order_number FROM orders WHERE customer_id = $1 ORDER BY order_number`, [asBuyer.customer.id]);
    const expected = inDb.map((row) => row.order_number);
    expect(expected).toHaveLength(2);

    const listed = await asBuyer.api.listOrders({ page_size: 100, sort: "order_number", direction: "asc" });
    expect(listed.items.map((order) => order.order_number)).toEqual(expected);
    expect(listed.total).toBe(2);
    expect(new Set(listed.items.map((order) => order.customer.id))).toEqual(new Set([asBuyer.customer.id]));

    const summary = await asBuyer.api.dashboard();
    expect(summary.total_orders).toBe(2);
    expect(summary.recent_orders.map((order) => order.order_number).sort()).toEqual(expected);
  });

  test("a buyer's settled revenue matches a SQL sum for that customer alone", async ({ asBuyer, newBuyer, data, db, setupApi }) => {
    const other = await newBuyer();
    const product = await data.product({ priceCents: 1000, stock: { YYZ1: 20 } });
    for (const customer of [asBuyer.customer, other.customer]) {
      const order = await data.order({ customer, lines: [{ product, quantity: customer === other.customer ? 3 : 1 }] });
      await setupApi.settle((await data.pay(order)).id);
    }
    const [row] = await db.query<{ sum: number }>(
      `SELECT coalesce(sum(p.amount_cents), 0)::bigint AS sum FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.status = 'SETTLED' AND o.customer_id = $1`,
      [asBuyer.customer.id],
    );
    expect((await asBuyer.api.dashboard()).settled_revenue_cents).toBe(row?.sum);
    expect(row?.sum).toBe(1130);
  });

  test("a buyer's account row is tied to their customer", async ({ asBuyer, db }) => {
    const [row] = await db.query<{ role: string; customer_id: string }>(`SELECT role, customer_id FROM users WHERE id = $1`, [asBuyer.user.id]);
    expect(row).toEqual({ role: "VIEWER", customer_id: asBuyer.customer.id });
  });
});
