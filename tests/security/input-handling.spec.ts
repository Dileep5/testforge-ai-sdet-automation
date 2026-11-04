import type { APIResponse } from "@playwright/test";
import { expect, test } from "../../framework/fixtures/api";
import { OpenApiContract } from "../../framework/contract/openapi";
import { SEED_USERS } from "../../framework/fixtures";
import { PREFIX, readApiError } from "../../framework/helpers/api-client";

const INJECTIONS = [
  `' OR '1'='1`,
  `' OR 1=1--`,
  `'; DROP TABLE orders;--`,
  `' UNION SELECT password_hash FROM users--`,
  `") OR ("1"="1`,
  `\\'; SELECT pg_sleep(5);--`,
  `%' OR sku LIKE '%`,
];

/** Things that must never reach a client: internals of the stack, and anything secret. */
const INTERNALS = /psycopg|sqlalchemy|traceback|\.py\b|pg_catalog|syntax error|password_hash|\$argon2|\/users\/deepu|site-packages|SELECT |INSERT |UPDATE |column "/i;

async function expectNoInternals(response: APIResponse): Promise<void> {
  expect(await response.text()).not.toMatch(INTERNALS);
}

test.describe("SQL injection through API inputs", { tag: "@security" }, () => {
  const searches: { name: string; path: string; param: string }[] = [
    { name: "product search", path: "/products", param: "q" },
    { name: "product category", path: "/products", param: "category" },
    { name: "inventory search", path: "/inventory", param: "q" },
    { name: "order search", path: "/orders", param: "q" },
    { name: "audit action", path: "/audit-logs", param: "action" },
    { name: "audit entity type", path: "/audit-logs", param: "entity_type" },
    { name: "audit entity id", path: "/audit-logs", param: "entity_id" },
  ];
  for (const { name, path, param } of searches) {
    test(`${name} treats injection as plain text`, async ({ asAdmin }) => {
      for (const payload of INJECTIONS) {
        const response = await asAdmin.api.send("GET", path, { params: { [param]: payload.slice(0, 32) } });
        expect.soft(response.status(), payload).toBe(200);
        const page = (await response.json()) as { total: number; items: unknown[] };
        expect.soft(page.total, payload).toBe(0);
        expect.soft(page.items, payload).toEqual([]);
      }
    });
  }

  test("sort columns accept only their allow-list", async ({ asAdmin }) => {
    for (const payload of INJECTIONS) {
      for (const path of ["/products", "/inventory", "/orders", "/orders/export.csv"]) {
        const response = await asAdmin.api.send("GET", path, { params: { sort: payload, direction: payload } });
        expect.soft(response.status(), `${path} ${payload}`).toBe(422);
        await expectNoInternals(response);
      }
    }
  });

  test("login cannot be bypassed", async ({ anonymous }) => {
    for (const password of INJECTIONS) {
      const response = await anonymous.send("POST", "/auth/login", { data: { email: SEED_USERS.admin.email, password } });
      await readApiError(response, 401, "INVALID_CREDENTIALS");
    }
    for (const email of INJECTIONS.map((payload) => `${payload}@e2e.example`)) {
      const response = await anonymous.send("POST", "/auth/login", { data: { email, password: "x" } });
      expect.soft([401, 422], email).toContain(response.status());
      await expectNoInternals(response);
    }
    await readApiError(await anonymous.send("GET", "/auth/me"), 401, "NOT_AUTHENTICATED");
  });

  test("injected text is stored and returned literally, and the tables survive", async ({ asManager, data, db, setupApi }) => {
    const payload = `Robert'); DROP TABLE orders;-- ${data.namespace}`;
    const customer = await data.customer(payload);
    expect(customer.name).toBe(payload);
    const product = await data.product({ name: payload, stock: { YYZ1: 5 } });
    expect(product.name).toBe(payload);
    const warehouse = await data.warehouse("YYZ1");
    const created = await asManager.api.send("POST", "/orders", {
      data: { customer_id: customer.id, warehouse_id: warehouse.id, notes: payload, items: [{ product_id: product.id, quantity: 1 }] },
    });
    expect(created.status()).toBe(201);
    const { order_number: orderNumber } = (await created.json()) as { order_number: string };
    expect(await db.query(`SELECT notes FROM orders WHERE order_number = $1`, [orderNumber])).toEqual([{ notes: payload }]);
    expect((await setupApi.products({ q: payload.slice(0, 100) })).items.map((item) => item.id)).toEqual([product.id]);
    const [tables] = await db.query<{ count: number }>(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('orders', 'users', 'payments', 'inventory', 'products', 'audit_logs')`);
    expect(tables?.count).toBe(6);
    const [warehouses] = await db.query<{ count: number }>(`SELECT count(*) FROM warehouses`);
    expect(warehouses?.count).toBe(4);
  });
});

test.describe("invalid identifiers", { tag: "@security" }, () => {
  const contract = new OpenApiContract();
  const templated = contract.operations.filter((operation) => operation.path.includes("{"));
  const invalid = ["not-a-uuid", "1", "-1", "null", "' OR '1'='1", "%00", "..%2f..%2fetc%2fpasswd", "a".repeat(500), "00000000-0000-0000-0000-00000000000g"];

  for (const operation of templated) {
    const label = operation.key.replace(PREFIX, "");
    test(`${label} refuses malformed ids without exposing internals`, async ({ asAdmin }) => {
      for (const id of invalid) {
        const url = operation.path.replace(/\{[^}]+\}/g, id.includes("%") ? id : encodeURIComponent(id));
        const response = await asAdmin.api.request.fetch(url, { method: operation.method, ...(operation.method === "patch" ? { data: {} } : {}) });
        // A path such as ../../etc/passwd may be normalised to a route that does not exist, which is also safe.
        expect.soft([404, 422], `${id.slice(0, 30)} got ${response.status()}`).toContain(response.status());
        await expectNoInternals(response);
      }
    });
  }
});

test.describe("sensitive data in responses", { tag: "@security" }, () => {
  test("validation errors never echo a submitted password", async ({ anonymous, asAdmin, data }) => {
    const secret = `Secret-Marker-${data.namespace}`;
    const responses = [
      await anonymous.send("POST", "/auth/login", { data: { email: "not-an-email", password: secret } }),
      await anonymous.send("POST", "/auth/login", { data: { email: "a@e2e.example", password: secret, extra: secret } }),
      await asAdmin.api.send("POST", "/users", { data: { email: "bad", full_name: "x", password: secret, role: "ROOT" } }),
      await asAdmin.api.send("POST", "/users", { data: { email: "a@e2e.example", full_name: "x", password: "short" } }),
    ];
    for (const response of responses) {
      expect(response.status()).toBe(422);
      expect(await response.text()).not.toContain(secret);
      expect(await response.text()).not.toContain('"short"');
    }
  });

  test("a failed login reveals nothing about the account", async ({ anonymous }) => {
    const response = await anonymous.send("POST", "/auth/login", { data: { email: SEED_USERS.admin.email, password: "wrong" } });
    const text = await response.text();
    expect(text).not.toContain(SEED_USERS.admin.email);
    expect(text).not.toMatch(/role|hash|active/i);
    expect(response.headers()["set-cookie"]).toBeUndefined();
  });

  test("a database-level failure returns a generic error", async ({ asManager, data }) => {
    const body = { sku: data.unique("SKU"), name: "x\u0000y", category: "E2E", unit_price_cents: 1 };
    const response = await asManager.api.send("POST", "/products", { data: body });
    const error = await readApiError(response, 422, "INVALID_DATA");
    expect(error.message).toBe("The request contains values that are not valid");
    await expectNoInternals(response);
  });

  test("user responses never contain a password or its hash", async ({ asAdmin, data }) => {
    const created = await data.user("MANAGER");
    const responses = [
      await asAdmin.api.send("GET", "/users"),
      await asAdmin.api.send("GET", `/users/${created.user.id}`),
      await asAdmin.api.send("PATCH", `/users/${created.user.id}`, { data: { full_name: "Changed" } }),
      await asAdmin.api.send("GET", "/auth/me"),
    ];
    for (const response of responses) {
      const text = await response.text();
      expect(text).not.toMatch(/password|argon2|hash/i);
      expect(text).not.toContain(created.password);
    }
  });

  test("audit responses never contain a session token or password", async ({ anonymous, asAdmin, loginAs, data }) => {
    const user = await data.user("VIEWER");
    const session = await loginAs(user);
    const token = await session.sessionCookie();
    await anonymous.send("POST", "/auth/login", { data: { email: user.email, password: `wrong-${user.password}` } });
    const text = await (await asAdmin.api.send("GET", "/audit-logs", { params: { page_size: 100 } })).text();
    expect(text).not.toContain(token);
    expect(text).not.toContain(user.password);
  });

  test("passwords are stored as Argon2 hashes", async ({ data, db }) => {
    const user = await data.user("VIEWER");
    const [row] = await db.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [user.user.id]);
    expect(row?.password_hash).toMatch(/^\$argon2id\$/);
    expect(row?.password_hash).not.toContain(user.password);
  });

  test("a buyer cannot see the idempotency keys staff used to pay their order", async ({ asBuyer, data }) => {
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer: asBuyer.customer, lines: [{ product, quantity: 1 }] });
    const key = data.unique("secret-key");
    const payment = await data.api.pay(order.id, "sim_success", key);
    for (const path of [`/orders/${order.id}`, `/orders/${order.id}/payments`, `/payments/${payment.id}`, `/orders/${order.id}/history`]) {
      const response = await asBuyer.api.send("GET", path);
      expect(response.status()).toBe(200);
      expect(await response.text(), path).not.toContain(key);
    }
  });
});
