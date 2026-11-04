import { expect, test } from "../../framework/fixtures/api";
import { OpenApiContract } from "../../framework/contract/openapi";
import { PREFIX, type ApiClient } from "../../framework/helpers/api-client";

type Actor = "anonymous" | "buyer" | "viewer" | "manager" | "admin";
const ALL_ROLES: Actor[] = ["buyer", "viewer", "manager", "admin"];
const OPERATORS: Actor[] = ["manager", "admin"];
const ADMIN: Actor[] = ["admin"];
const PUBLIC = "public";

/**
 * Who may call each operation. The spec does not carry roles, so the policy is stated here, and a
 * test fails if the spec gains an operation this table does not mention.
 */
const POLICY: Record<string, Actor[] | typeof PUBLIC> = {
  "GET /health": PUBLIC,
  "GET /ready": PUBLIC,
  "POST /auth/login": PUBLIC,
  "POST /auth/logout": PUBLIC,
  "GET /auth/me": ALL_ROLES,
  "GET /roles": ALL_ROLES,
  "GET /users": ADMIN,
  "POST /users": ADMIN,
  "GET /users/{user_id}": ADMIN,
  "PATCH /users/{user_id}": ADMIN,
  "GET /customers": ALL_ROLES,
  "POST /customers": ADMIN,
  "GET /warehouses": ALL_ROLES,
  "GET /warehouses/{warehouse_id}": ALL_ROLES,
  "GET /products": ALL_ROLES,
  "POST /products": OPERATORS,
  "GET /products/categories": ALL_ROLES,
  "GET /products/{product_id}": ALL_ROLES,
  "PATCH /products/{product_id}": OPERATORS,
  "DELETE /products/{product_id}": ADMIN,
  "GET /inventory": ALL_ROLES,
  "GET /inventory/{inventory_id}": ALL_ROLES,
  "PATCH /inventory/{inventory_id}": OPERATORS,
  "GET /orders": ALL_ROLES,
  "POST /orders": OPERATORS,
  "GET /orders/export.csv": ALL_ROLES,
  "GET /orders/{order_id}": ALL_ROLES,
  "GET /orders/{order_id}/history": ALL_ROLES,
  "PATCH /orders/{order_id}/status": OPERATORS,
  "GET /orders/{order_id}/payments": ALL_ROLES,
  "POST /orders/{order_id}/payments": OPERATORS,
  "GET /payments/{payment_id}": ALL_ROLES,
  "POST /payments/{payment_id}/settle": OPERATORS,
  "GET /audit-logs": ADMIN,
  "GET /dashboard/summary": ALL_ROLES,
};

const contract = new OpenApiContract();
const MISSING_ID = "00000000-0000-4000-8000-000000000000";

test.describe("authorization of every operation", { tag: "@security" }, () => {
  test("the policy covers exactly the operations in the spec", () => {
    const fromSpec = contract.operations.map((operation) => operation.key.replace(PREFIX, "")).sort();
    expect(Object.keys(POLICY).sort()).toEqual(fromSpec);
  });

  for (const operation of contract.operations) {
    const label = operation.key.replace(PREFIX, "");
    const policy = POLICY[label];
    if (policy && policy !== PUBLIC) {
      test(`${label} admits only ${policy.join(", ")}`, async ({ anonymous, asBuyer, asViewer, asManager, asAdmin }) => {
        const clients: Record<Actor, ApiClient> = { anonymous, buyer: asBuyer.api, viewer: asViewer.api, manager: asManager.api, admin: asAdmin.api };
        const path = operation.path.replace(PREFIX, "").replace(/\{[^}]+\}/g, MISSING_ID);
        const method = operation.method.toUpperCase() as "GET" | "POST" | "PATCH" | "DELETE";
        // An empty body and an id that does not exist: a caller who gets through can change nothing.
        const send = (client: ApiClient) => client.send(method, path, method === "GET" || method === "DELETE" ? {} : { data: {} });

        expect.soft((await send(anonymous)).status(), "anonymous").toBe(401);
        for (const actor of ALL_ROLES) {
          const status = (await send(clients[actor])).status();
          expect.soft(policy.includes(actor) ? status !== 401 && status !== 403 : status === 403, `${actor} got ${status}`).toBe(true);
        }
      });
    }
  }
});

test.describe("role escalation", { tag: "@security" }, () => {
  test("a Viewer cannot promote themselves, and a Manager cannot manage users", async ({ asViewer, asManager, data, db }) => {
    const viewerSelf = await asViewer.api.send("PATCH", `/users/${asViewer.user.id}`, { data: { role: "ADMIN" } });
    expect(viewerSelf.status()).toBe(403);
    const managerSelf = await asManager.api.send("PATCH", `/users/${asManager.user.id}`, { data: { role: "ADMIN" } });
    expect(managerSelf.status()).toBe(403);
    const email = `${data.unique("evil").toLowerCase()}@e2e.example`;
    const created = await asManager.api.send("POST", "/users", { data: { email, full_name: "Evil", password: "E2E-Long-Password-1", role: "ADMIN" } });
    expect(created.status()).toBe(403);
    const rows = await db.query<{ role: string }>(`SELECT role FROM users WHERE id = ANY($1::uuid[])`, [[asViewer.user.id, asManager.user.id]]);
    expect(rows.map((row) => row.role).sort()).toEqual(["MANAGER", "VIEWER"]);
    expect(await db.query(`SELECT 1 FROM users WHERE email = $1`, [email])).toEqual([]);
  });

  test("a role cannot be smuggled in through login or fields the API does not accept", async ({ anonymous, asAdmin, data }) => {
    const user = await data.user("VIEWER");
    const smuggled = await anonymous.send("POST", "/auth/login", { data: { email: user.email, password: user.password, role: "ADMIN", permissions: ["users:manage"] } });
    expect(smuggled.status()).toBe(422);
    for (const body of [{ customer_id: MISSING_ID }, { password_hash: "x" }, { permissions: ["users:manage"] }]) {
      expect((await asAdmin.api.send("PATCH", `/users/${user.user.id}`, { data: body })).status()).toBe(422);
    }
  });

  test("a customer account cannot be promoted out of its customer scope", async ({ asAdmin, asBuyer, db }) => {
    for (const role of ["MANAGER", "ADMIN"]) {
      expect((await asAdmin.api.send("PATCH", `/users/${asBuyer.user.id}`, { data: { role } })).status()).toBe(422);
    }
    expect(await db.query(`SELECT role FROM users WHERE id = $1`, [asBuyer.user.id])).toEqual([{ role: "VIEWER" }]);
    expect((await asBuyer.api.me()).role).toBe("VIEWER");
  });

  test("an admin cannot change their own role or deactivate themselves", async ({ asAdmin, db }) => {
    expect((await asAdmin.api.send("PATCH", `/users/${asAdmin.user.id}`, { data: { role: "VIEWER" } })).status()).toBe(409);
    expect((await asAdmin.api.send("PATCH", `/users/${asAdmin.user.id}`, { data: { is_active: false } })).status()).toBe(409);
    expect(await db.query(`SELECT role, is_active FROM users WHERE id = $1`, [asAdmin.user.id])).toEqual([{ role: "ADMIN", is_active: true }]);
  });

  test("a Viewer or buyer cannot change inventory, and nothing is written", async ({ asViewer, asBuyer, data, db }) => {
    const product = await data.product({ stock: { YYZ1: 5 } });
    const row = product.stock.find((item) => item.warehouse.code === "YYZ1");
    const body = { quantity: 999, expected_version: row?.version, reason: "unauthorized" };
    for (const api of [asViewer.api, asBuyer.api]) {
      expect((await api.send("PATCH", `/inventory/${row?.inventory_id}`, { data: body })).status()).toBe(403);
    }
    expect(await db.stock(product.id, "YYZ1")).toBe(5);
    expect(await db.query(`SELECT 1 FROM audit_logs WHERE entity_id = $1 AND details->>'reason' = 'unauthorized'`, [row?.inventory_id])).toEqual([]);
  });

  test("a Viewer cannot create orders or payments, or settle or move an order", async ({ asViewer, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const warehouse = await data.warehouse("YYZ1");
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const payment = await data.pay(order);
    const attempts = [
      asViewer.api.send("POST", "/orders", { data: { customer_id: customer.id, warehouse_id: warehouse.id, items: [{ product_id: product.id, quantity: 1 }] } }),
      asViewer.api.send("POST", `/orders/${order.id}/payments`, { data: { method_token: "sim_success" }, headers: { "Idempotency-Key": data.unique("key") } }),
      asViewer.api.send("POST", `/payments/${payment.id}/settle`),
      asViewer.api.send("PATCH", `/orders/${order.id}/status`, { data: { status: "CANCELLED" } }),
    ];
    expect((await Promise.all(attempts)).map((response) => response.status())).toEqual([403, 403, 403, 403]);
    expect((await db.order(order.order_number)).status).toBe("PENDING");
    expect((await db.payments(order.id)).map((row) => row.status)).toEqual(["AUTHORIZED"]);
    expect(await db.countOrdersForCustomer(customer.id)).toBe(1);
  });
});

test.describe("cross-site requests", { tag: "@security" }, () => {
  test("a write from a foreign origin is refused even with a valid session, and changes nothing", async ({ asManager, data, db }) => {
    const product = await data.product();
    for (const origin of ["https://evil.example", "null", "http://localhost:5273.evil.example"]) {
      const response = await asManager.api.send("PATCH", `/products/${product.id}`, { data: { name: "Hijacked" }, headers: { Origin: origin } });
      expect(response.status(), origin).toBe(403);
    }
    expect(await db.query(`SELECT name FROM products WHERE id = $1`, [product.id])).toEqual([{ name: product.name }]);
  });

  test("login and logout are protected too, and a read is not", async ({ anonymous, asViewer }) => {
    const headers = { Origin: "https://evil.example" };
    expect((await anonymous.send("POST", "/auth/login", { data: { email: "a@e2e.example", password: "x" }, headers })).status()).toBe(403);
    expect((await asViewer.api.send("POST", "/auth/logout", { headers })).status()).toBe(403);
    expect((await asViewer.api.me()).email).toBe(asViewer.user.email);
    expect((await asViewer.api.send("GET", "/products", { headers })).status()).toBe(200);
  });

  test("the app's own origin may write", async ({ asManager, data }) => {
    const product = await data.product();
    const response = await asManager.api.send("PATCH", `/products/${product.id}`, { data: { description: "fine" }, headers: { Origin: "http://localhost:5273" } });
    expect(response.status()).toBe(200);
  });
});
