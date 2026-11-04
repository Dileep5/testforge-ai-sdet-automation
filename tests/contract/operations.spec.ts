import type { APIResponse } from "@playwright/test";
import { expect, test } from "../../framework/fixtures/api";
import { OpenApiContract, type JsonSchema, type Operation } from "../../framework/contract/openapi";
import type { TestData } from "../../framework/factories/test-data";
import { PREFIX, readApiError, type ApiClient } from "../../framework/helpers/api-client";
import { SEED_USERS } from "../../framework/fixtures";

const contract = new OpenApiContract();
const p = (path: string) => `${PREFIX}${path}`;

interface Ctx {
  admin: ApiClient;
  anon: ApiClient;
  data: TestData;
}

async function placedOrder({ data }: Ctx) {
  const customer = await data.customer();
  const product = await data.product({ stock: { YYZ1: 5 } });
  return data.order({ customer, lines: [{ product, quantity: 1 }] });
}

/**
 * How to reach the success response of each operation. A test below fails if the spec gains an
 * operation that is missing here, so a new endpoint cannot go without a contract check.
 */
const SUCCESS: Record<string, { status: number; call: (ctx: Ctx) => Promise<APIResponse> }> = {
  [`GET ${p("/health")}`]: { status: 200, call: ({ admin }) => admin.send("GET", "/health") },
  [`GET ${p("/ready")}`]: { status: 200, call: ({ admin }) => admin.send("GET", "/ready") },
  [`POST ${p("/auth/login")}`]: { status: 200, call: ({ anon }) => anon.send("POST", "/auth/login", { data: SEED_USERS.viewer }) },
  [`POST ${p("/auth/logout")}`]: { status: 204, call: ({ anon }) => anon.send("POST", "/auth/logout") },
  [`GET ${p("/auth/me")}`]: { status: 200, call: ({ admin }) => admin.send("GET", "/auth/me") },
  [`GET ${p("/roles")}`]: { status: 200, call: ({ admin }) => admin.send("GET", "/roles") },
  [`GET ${p("/users")}`]: { status: 200, call: ({ admin }) => admin.send("GET", "/users") },
  [`POST ${p("/users")}`]: {
    status: 201,
    call: async ({ admin, data }) => {
      const customer = await data.customer();
      return admin.send("POST", "/users", {
        data: { email: `${data.unique("c").toLowerCase()}@e2e.example`, full_name: "Contract", password: "E2E-Long-Password-1", role: "VIEWER", customer_id: customer.id },
      });
    },
  },
  [`GET ${p("/users/{user_id}")}`]: { status: 200, call: async ({ admin, data }) => admin.send("GET", `/users/${(await data.user("VIEWER")).user.id}`) },
  [`PATCH ${p("/users/{user_id}")}`]: { status: 200, call: async ({ admin, data }) => admin.send("PATCH", `/users/${(await data.user("VIEWER")).user.id}`, { data: { full_name: "Renamed" } }) },
  [`GET ${p("/customers")}`]: { status: 200, call: ({ admin }) => admin.send("GET", "/customers") },
  [`POST ${p("/customers")}`]: { status: 201, call: ({ admin, data }) => admin.send("POST", "/customers", { data: { code: data.unique("C"), name: "Contract", contact_email: "c@e2e.example" } }) },
  [`GET ${p("/warehouses")}`]: { status: 200, call: ({ admin }) => admin.send("GET", "/warehouses") },
  [`GET ${p("/warehouses/{warehouse_id}")}`]: { status: 200, call: async ({ admin, data }) => admin.send("GET", `/warehouses/${(await data.warehouse("YYZ1")).id}`) },
  [`GET ${p("/products")}`]: { status: 200, call: ({ admin }) => admin.send("GET", "/products", { params: { page_size: 100 } }) },
  [`POST ${p("/products")}`]: {
    status: 201,
    call: ({ admin, data }) => admin.send("POST", "/products", { data: { sku: data.unique("SKU"), name: "Contract", description: "Full", category: "E2E", unit_price_cents: 100 } }),
  },
  [`GET ${p("/products/categories")}`]: { status: 200, call: ({ admin }) => admin.send("GET", "/products/categories") },
  [`GET ${p("/products/{product_id}")}`]: { status: 200, call: async ({ admin, data }) => admin.send("GET", `/products/${(await data.product()).id}`) },
  [`PATCH ${p("/products/{product_id}")}`]: { status: 200, call: async ({ admin, data }) => admin.send("PATCH", `/products/${(await data.product()).id}`, { data: { description: "Changed" } }) },
  [`DELETE ${p("/products/{product_id}")}`]: { status: 204, call: async ({ admin, data }) => admin.send("DELETE", `/products/${(await data.product()).id}`) },
  [`GET ${p("/inventory")}`]: { status: 200, call: ({ admin }) => admin.send("GET", "/inventory", { params: { page_size: 100 } }) },
  [`GET ${p("/inventory/{inventory_id}")}`]: { status: 200, call: async ({ admin, data }) => admin.send("GET", `/inventory/${(await data.product()).stock[0]?.inventory_id}`) },
  [`PATCH ${p("/inventory/{inventory_id}")}`]: {
    status: 200,
    call: async ({ admin, data }) => {
      const row = (await data.product()).stock[0];
      return admin.send("PATCH", `/inventory/${row?.inventory_id}`, { data: { quantity: 3, expected_version: row?.version, reason: "contract" } });
    },
  },
  [`GET ${p("/orders")}`]: {
    status: 200,
    call: async (ctx) => {
      await ctx.data.pay(await placedOrder(ctx));
      return ctx.admin.send("GET", "/orders", { params: { page_size: 100 } });
    },
  },
  [`POST ${p("/orders")}`]: {
    status: 201,
    call: async ({ admin, data }) => {
      const customer = await data.customer();
      const product = await data.product({ stock: { YYZ1: 5 } });
      const warehouse = await data.warehouse("YYZ1");
      return admin.send("POST", "/orders", { data: { customer_id: customer.id, warehouse_id: warehouse.id, items: [{ product_id: product.id, quantity: 1 }] } });
    },
  },
  [`GET ${p("/orders/export.csv")}`]: { status: 200, call: ({ admin }) => admin.send("GET", "/orders/export.csv", { params: { date_from: "2999-01-01" } }) },
  [`GET ${p("/orders/{order_id}")}`]: {
    status: 200,
    call: async (ctx) => {
      const order = await placedOrder(ctx);
      await ctx.data.pay(order);
      return ctx.admin.send("GET", `/orders/${order.id}`);
    },
  },
  [`GET ${p("/orders/{order_id}/history")}`]: { status: 200, call: async (ctx) => ctx.admin.send("GET", `/orders/${(await placedOrder(ctx)).id}/history`) },
  [`PATCH ${p("/orders/{order_id}/status")}`]: { status: 200, call: async (ctx) => ctx.admin.send("PATCH", `/orders/${(await placedOrder(ctx)).id}/status`, { data: { status: "CANCELLED" } }) },
  [`GET ${p("/orders/{order_id}/payments")}`]: {
    status: 200,
    call: async (ctx) => {
      const order = await placedOrder(ctx);
      await ctx.data.pay(order);
      return ctx.admin.send("GET", `/orders/${order.id}/payments`);
    },
  },
  [`POST ${p("/orders/{order_id}/payments")}`]: {
    status: 201,
    call: async (ctx) => ctx.admin.send("POST", `/orders/${(await placedOrder(ctx)).id}/payments`, { data: { method_token: "sim_success" }, headers: { "Idempotency-Key": ctx.data.unique("key") } }),
  },
  [`GET ${p("/payments/{payment_id}")}`]: { status: 200, call: async (ctx) => ctx.admin.send("GET", `/payments/${(await ctx.data.pay(await placedOrder(ctx))).id}`) },
  [`POST ${p("/payments/{payment_id}/settle")}`]: { status: 200, call: async (ctx) => ctx.admin.send("POST", `/payments/${(await ctx.data.pay(await placedOrder(ctx))).id}/settle`) },
  [`GET ${p("/audit-logs")}`]: { status: 200, call: ({ admin }) => admin.send("GET", "/audit-logs", { params: { page_size: 100 } }) },
  [`GET ${p("/dashboard/summary")}`]: { status: 200, call: ({ admin }) => admin.send("GET", "/dashboard/summary") },
};

test.describe("response contracts", { tag: "@contract" }, () => {
  test("every operation in the spec has a case here, and nothing here is stale", () => {
    expect(Object.keys(SUCCESS).sort()).toEqual(contract.operations.map((operation) => operation.key).sort());
  });

  // The observeContract fixture validates each response against the spec and fails the test if any is wrong.
  for (const operation of contract.operations) {
    const success = SUCCESS[operation.key];
    if (success) {
      test(`${operation.key} returns its documented ${success.status}`, async ({ setupApi, anonymous, data }) => {
        const response = await success.call({ admin: setupApi, anon: anonymous, data });
        expect(response.status(), await response.text()).toBe(success.status);
      });
    }
  }

  test("a replayed payment matches its documented 200", async ({ setupApi, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const options = { data: { method_token: "sim_success" }, headers: { "Idempotency-Key": data.unique("key") } };
    expect((await setupApi.send("POST", `/orders/${order.id}/payments`, options)).status()).toBe(201);
    expect((await setupApi.send("POST", `/orders/${order.id}/payments`, options)).status()).toBe(200);
  });
});

test.describe("error contracts", { tag: "@contract" }, () => {
  async function expectEnvelope(response: APIResponse, status: number, code: string): Promise<void> {
    const error = await readApiError(response, status, code);
    expect(Object.keys(error).sort()).toEqual(["code", "details", "message", "request_id"]);
    expect(error.message.length).toBeGreaterThan(0);
    expect(Array.isArray(error.details)).toBe(true);
    expect(error.request_id).toBe(response.headers()["x-request-id"]);
  }

  test("each kind of error has the same envelope and a matching request id", async ({ anonymous, asViewer, asManager, data }) => {
    const product = await data.product();
    await expectEnvelope(await anonymous.send("GET", "/orders"), 401, "NOT_AUTHENTICATED");
    await expectEnvelope(await anonymous.send("POST", "/auth/login", { data: { email: SEED_USERS.admin.email, password: "wrong" } }), 401, "INVALID_CREDENTIALS");
    await expectEnvelope(await asViewer.api.send("DELETE", `/products/${product.id}`), 403, "FORBIDDEN");
    await expectEnvelope(await asManager.api.send("GET", "/products/00000000-0000-4000-8000-000000000000"), 404, "NOT_FOUND");
    await expectEnvelope(await asManager.api.send("POST", "/products", { data: { sku: product.sku, name: "n", category: "c", unit_price_cents: 1 } }), 409, "DUPLICATE_SKU");
    await expectEnvelope(await asManager.api.send("POST", "/products", { data: {} }), 422, "VALIDATION_ERROR");
    await expectEnvelope(await asManager.api.send("POST", "/products", { data: Buffer.from("{"), headers: { "Content-Type": "application/json" } }), 400, "INVALID_JSON");
    await expectEnvelope(await asManager.api.send("POST", "/products", { data: {}, headers: { Origin: "https://evil.example" } }), 403, "ORIGIN_NOT_ALLOWED");
    await expectEnvelope(await asManager.api.send("GET", "/products", { params: { q: "\u0000" } }), 422, "INVALID_DATA");
  });
});

/** A value of the wrong JSON type for this schema, derived from the spec rather than listed by hand. */
function wrongTypeFor(schema: JsonSchema): unknown {
  const resolved = contract.resolve(schema);
  const variants = (resolved.anyOf as JsonSchema[] | undefined)?.map((item) => contract.resolve(item)).filter((item) => item.type !== "null");
  const first = variants?.[0] ?? resolved;
  const type = first.type ?? (first.enum ? "string" : undefined);
  if (type === "integer" || type === "number") return "1";
  if (type === "boolean") return "maybe";
  if (type === "array" || type === "object") return "x";
  return 12345;
}

/** Query values the spec says are invalid. Empty when the parameter has no constraint to break. */
function invalidQueryValues(schema: JsonSchema): string[] {
  const resolved = contract.resolve(schema);
  const inner = (resolved.anyOf as JsonSchema[] | undefined)?.map((item) => contract.resolve(item)).find((item) => item.type !== "null") ?? resolved;
  const values: string[] = [];
  if (inner.enum) values.push("__not_in_enum__");
  if (inner.type === "integer") values.push("abc", "1.5");
  if (typeof inner.minimum === "number") values.push(String(inner.minimum - 1));
  if (typeof inner.maximum === "number") values.push(String(inner.maximum + 1));
  if (inner.type === "boolean") values.push("maybe");
  if (inner.format === "uuid" || inner.format === "date") values.push("not-valid");
  if (typeof inner.maxLength === "number") values.push("x".repeat(inner.maxLength + 1));
  return values;
}

interface RequestCase {
  params?: Record<string, string>;
  headers?: () => Record<string, string>;
  /** Login would replace the admin session, so it goes through a client with no session. */
  anonymous?: boolean;
  body: () => Record<string, unknown>;
}

function sender(valid: RequestCase, clients: { anonymous: ApiClient; admin: ApiClient }, method: "POST" | "PATCH", path: string) {
  const client = valid.anonymous ? clients.anonymous : clients.admin;
  return (body: unknown) => client.send(method, path, { data: body, headers: valid.headers?.() ?? {} });
}

function fill(path: string, params: Record<string, string> = {}): string {
  return path.replace(PREFIX, "").replace(/\{([^}]+)\}/g, (_, name: string) => params[name] ?? "00000000-0000-4000-8000-000000000000");
}

/** A valid request for every operation with a body. The checks below derive the rest from the spec. */
async function requestCase(operation: Operation, { data }: Ctx): Promise<RequestCase> {
  const order = async () => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    return data.order({ customer, lines: [{ product, quantity: 1 }] });
  };
  switch (operation.key) {
    case `POST ${p("/auth/login")}`:
      return { anonymous: true, body: () => ({ ...SEED_USERS.viewer }) };
    case `POST ${p("/users")}`:
      return { body: () => ({ email: `${data.unique("u").toLowerCase()}@e2e.example`, full_name: "Contract", password: "E2E-Long-Password-1", role: "VIEWER", customer_id: null }) };
    case `PATCH ${p("/users/{user_id}")}`:
      return { params: { user_id: (await data.user("VIEWER")).user.id }, body: () => ({ full_name: "Contract", role: "VIEWER", is_active: true }) };
    case `POST ${p("/customers")}`:
      return { body: () => ({ code: data.unique("C"), name: "Contract", contact_email: "c@e2e.example" }) };
    case `POST ${p("/products")}`:
      return { body: () => ({ sku: data.unique("SKU"), name: "Contract", description: "d", category: "E2E", unit_price_cents: 100 }) };
    case `PATCH ${p("/products/{product_id}")}`:
      return { params: { product_id: (await data.product()).id }, body: () => ({ name: "n", description: "d", category: "c", unit_price_cents: 5, is_active: true }) };
    case `PATCH ${p("/inventory/{inventory_id}")}`: {
      const row = (await data.product()).stock[0];
      if (!row) throw new Error("A product has stock rows");
      return { params: { inventory_id: row.inventory_id }, body: () => ({ quantity: 3, expected_version: row.version, reason: "contract" }) };
    }
    case `POST ${p("/orders")}`: {
      const customer = await data.customer();
      const product = await data.product({ stock: { YYZ1: 50 } });
      const warehouse = await data.warehouse("YYZ1");
      return { body: () => ({ customer_id: customer.id, warehouse_id: warehouse.id, items: [{ product_id: product.id, quantity: 1 }], notes: "contract" }) };
    }
    case `PATCH ${p("/orders/{order_id}/status")}`:
      return { params: { order_id: (await order()).id }, body: () => ({ status: "CANCELLED", note: "contract" }) };
    case `POST ${p("/orders/{order_id}/payments")}`:
      return { params: { order_id: (await order()).id }, headers: () => ({ "Idempotency-Key": data.unique("key") }), body: () => ({ method_token: "sim_declined" }) };
    default:
      throw new Error(`No valid request defined for ${operation.key}`);
  }
}

test.describe("request contracts", { tag: "@contract" }, () => {
  const withBody = contract.operations.filter((operation) => operation.definition.requestBody);

  test("every operation with a body is covered", () => {
    expect(withBody.length).toBe(10);
  });

  for (const operation of withBody) {
    const schema = contract.resolve(operation.definition.requestBody!.content["application/json"]!.schema);
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = (schema.required ?? []) as string[];
    const method = operation.method.toUpperCase() as "POST" | "PATCH";

    test(`${operation.key}: the spec and the server agree on valid and invalid bodies`, async ({ setupApi, anonymous, data }) => {
      const valid = await requestCase(operation, { admin: setupApi, anon: anonymous, data });
      const path = fill(operation.path, valid.params);
      const send = sender(valid, { anonymous, admin: setupApi }, method, path);

      for (const field of required) {
        const body = valid.body();
        delete body[field];
        expect.soft(contract.checkRequestBody(operation, body), `spec rejects missing ${field}`).not.toBe("");
        const error = await readApiError(await send(body), 422, "VALIDATION_ERROR");
        expect.soft(error.details.map((item) => item.field), `missing ${field}`).toContain(`body.${field}`);
      }
      for (const [field, fieldSchema] of Object.entries(properties)) {
        const body = { ...valid.body(), [field]: wrongTypeFor(fieldSchema) };
        expect.soft(contract.checkRequestBody(operation, body), `spec rejects wrong type for ${field}`).not.toBe("");
        const response = await send(body);
        expect.soft(response.status(), `wrong type for ${field}: ${await response.text()}`).toBe(422);
      }
      const extra = { ...valid.body(), __unexpected: true };
      expect.soft(contract.checkRequestBody(operation, extra), "spec rejects an unknown field").not.toBe("");
      const error = await readApiError(await send(extra), 422, "VALIDATION_ERROR");
      expect.soft(error.details.map((item) => item.field)).toContain("body.__unexpected");

      // Last, because it changes data: the unmutated body is accepted, so each 422 above came from its mutation.
      const baseline = valid.body();
      expect(contract.checkRequestBody(operation, baseline)).toBe("");
      const accepted = await send(baseline);
      expect(accepted.ok(), await accepted.text()).toBe(true);
    });
  }

  test("a product needs only its required fields, and the optional ones get defaults", async ({ setupApi, data }) => {
    const operation = contract.get(`POST ${p("/products")}`);
    const schema = contract.resolve(operation.definition.requestBody!.content["application/json"]!.schema);
    const body = { sku: data.unique("SKU"), name: "Min", category: "E2E", unit_price_cents: 0 };
    expect(Object.keys(body).sort()).toEqual([...(schema.required as string[])].sort());
    const response = await setupApi.send("POST", "/products", { data: body });
    expect(response.status()).toBe(201);
    expect(((await response.json()) as { description: string }).description).toBe("");
  });

  test("an order needs no notes, and defaults them to empty", async ({ setupApi, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const warehouse = await data.warehouse("YYZ1");
    const response = await setupApi.send("POST", "/orders", { data: { customer_id: customer.id, warehouse_id: warehouse.id, items: [{ product_id: product.id, quantity: 1 }] } });
    expect(response.status()).toBe(201);
    expect(((await response.json()) as { notes: string }).notes).toBe("");
  });

  test("a required header in the spec is enforced by the server", async ({ setupApi, data }) => {
    const operation = contract.get(`POST ${p("/orders/{order_id}/payments")}`);
    const headers = (operation.definition.parameters ?? []).filter((item) => item.in === "header" && item.required);
    expect(headers.map((item) => item.name.toLowerCase())).toEqual(["idempotency-key"]);
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const error = await readApiError(await setupApi.send("POST", `/orders/${order.id}/payments`, { data: { method_token: "sim_success" } }), 422, "VALIDATION_ERROR");
    expect(error.details.map((item) => item.field)).toContain("header.idempotency-key");
  });

  for (const operation of contract.operations.filter((item) => (item.definition.parameters ?? []).some((param) => param.in === "query"))) {
    test(`${operation.key}: every constrained query parameter rejects what the spec forbids`, async ({ setupApi }) => {
      const path = fill(operation.path);
      for (const parameter of (operation.definition.parameters ?? []).filter((item) => item.in === "query")) {
        for (const value of invalidQueryValues(parameter.schema)) {
          const response = await setupApi.send("GET", path, { params: { [parameter.name]: value } });
          expect.soft(response.status(), `${parameter.name}=${value.slice(0, 20)}`).toBe(422);
          const body = (await response.json()) as { error: { details: { field: string }[] } };
          expect.soft(body.error.details.map((item) => item.field), parameter.name).toContain(`query.${parameter.name}`);
        }
      }
    });
  }
});
