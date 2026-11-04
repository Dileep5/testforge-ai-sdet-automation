import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "../../framework/fixtures/api";
import { findBreakingChanges, type BreakingChange } from "../../framework/contract/breaking-changes";
import { loadCommittedSpec, OpenApiContract, type OpenApiDocument } from "../../framework/contract/openapi";

const ROOT = path.resolve(__dirname, "../..");
const SPEC_FILE = "apps/api/openapi.json";
const ALLOWLIST = path.join(ROOT, "apps/api/openapi-accepted-breaking-changes.json");
const contract = new OpenApiContract();

test.describe("the OpenAPI document", { tag: "@contract" }, () => {
  test("the running API serves exactly the committed spec", async ({ anonymous }) => {
    const live = await anonymous.request.get("/api/v1/openapi.json");
    expect(live.status()).toBe(200);
    expect(await live.json()).toEqual(loadCommittedSpec());
  });

  test("every error response documents the standard envelope", () => {
    const schemas = contract.operations.flatMap((operation) =>
      ["400", "401", "403", "404", "409", "422"].flatMap((status) => {
        const media = operation.definition.responses[status]?.content?.["application/json"];
        return media ? [media.schema] : [];
      }),
    );
    expect(schemas.length).toBe((contract.operations.length - 2) * 6);
    expect(new Set(schemas.map((schema) => schema.$ref))).toEqual(new Set(["#/components/schemas/ErrorResponse"]));
    const documented = contract.operations.filter((operation) => operation.definition.responses["401"]);
    expect(documented.length).toBe(contract.operations.length - 2);
  });

  test("the spec has no breaking change compared to the base revision", () => {
    // CI sets this to the merge base. Locally it compares the working tree to the last commit.
    const baseRef = process.env.OPENAPI_BASE_REF ?? "HEAD";
    const baseText = execFileSync("git", ["show", `${baseRef}:${SPEC_FILE}`], { cwd: ROOT, encoding: "utf8" });
    const accepted = JSON.parse(readFileSync(ALLOWLIST, "utf8")) as { rule: string; location: string; reason: string }[];
    const changes = findBreakingChanges(JSON.parse(baseText) as OpenApiDocument, loadCommittedSpec());
    const unaccepted = changes.filter((change) => !accepted.some((item) => item.rule === change.rule && item.location === change.location));
    expect(unaccepted, `breaking changes since ${baseRef}: acknowledge deliberate ones in ${path.basename(ALLOWLIST)}`).toEqual([]);
  });
});

test.describe("breaking change detection", { tag: "@contract" }, () => {
  const base = loadCommittedSpec();
  const edit = (change: (spec: OpenApiDocument) => void): OpenApiDocument => {
    const copy = structuredClone(base);
    change(copy);
    return copy;
  };
  const schema = (spec: OpenApiDocument, name: string) => {
    const found = spec.components.schemas[name];
    if (!found) throw new Error(`No schema ${name}`);
    return found as { properties: Record<string, Record<string, unknown>>; required: string[] };
  };
  const orders = (spec: OpenApiDocument) => spec.paths["/api/v1/orders"]!;
  const statusEnum = (spec: OpenApiDocument) => spec.components.schemas.OrderStatus as { enum: string[] };

  test("identical specs have no breaking changes", () => {
    expect(findBreakingChanges(base, structuredClone(base))).toEqual([]);
  });

  const breaking: { name: string; rule: string; location: RegExp; change: (spec: OpenApiDocument) => void }[] = [
    { name: "removing an operation", rule: "operation-removed", location: /^DELETE .*products/, change: (s) => delete s.paths["/api/v1/products/{product_id}"]!.delete },
    { name: "removing a path", rule: "operation-removed", location: /^GET .*roles/, change: (s) => delete s.paths["/api/v1/roles"] },
    { name: "a new required request field", rule: "request-property-became-required", location: /POST .*products body\.description/, change: (s) => void schema(s, "ProductCreate").required.push("description") },
    { name: "a request field removed", rule: "request-property-removed", location: /POST .*orders body\.notes/, change: (s) => delete schema(s, "OrderCreate").properties.notes },
    { name: "a request type change", rule: "type-changed", location: /POST .*products body\.unit_price_cents/, change: (s) => void (schema(s, "ProductCreate").properties.unit_price_cents!.type = "string") },
    { name: "a tightened request limit", rule: "request-constraint-tightened", location: /POST .*orders body\.items/, change: (s) => void (schema(s, "OrderCreate").properties.items!.maxItems = 5) },
    { name: "a tighter request pattern", rule: "request-constraint-tightened", location: /POST .*products body\.sku/, change: (s) => void (schema(s, "ProductCreate").properties.sku!.pattern = "^[A-Z]+$") },
    { name: "a request enum value removed", rule: "request-enum-value-removed", location: /PATCH .*status body\.status/, change: (s) => void statusEnum(s).enum.pop() },
    { name: "a required query parameter added", rule: "required-parameter-added", location: /GET .*\/orders query\.tenant/, change: (s) => void orders(s).get!.parameters!.push({ name: "tenant", in: "query", required: true, schema: { type: "string" } }) },
    { name: "a query parameter removed", rule: "parameter-removed", location: /GET .*\/orders query\.status/, change: (s) => { orders(s).get!.parameters = orders(s).get!.parameters!.filter((item) => item.name !== "status"); } },
    { name: "a query parameter made required", rule: "parameter-became-required", location: /GET .*\/orders query\.status/, change: (s) => void (orders(s).get!.parameters!.find((item) => item.name === "status")!.required = true) },
    { name: "a response status removed", rule: "response-status-removed", location: /POST .*orders 201/, change: (s) => delete orders(s).post!.responses["201"] },
    { name: "a response field removed", rule: "response-property-removed", location: /GET .*orders 200 .*total_cents/, change: (s) => delete schema(s, "OrderSummaryOut").properties.total_cents },
    { name: "a response field made optional", rule: "response-property-became-optional", location: /GET .*orders 200 .*total_cents/, change: (s) => { const target = schema(s, "OrderSummaryOut"); target.required = target.required.filter((item) => item !== "total_cents"); } },
    { name: "a response type change", rule: "type-changed", location: /GET .*orders 200 .*total_cents/, change: (s) => void (schema(s, "OrderSummaryOut").properties.total_cents!.type = "string") },
    { name: "a response field made nullable", rule: "response-became-nullable", location: /GET .*orders 200 .*total_cents/, change: (s) => { schema(s, "OrderSummaryOut").properties.total_cents = { anyOf: [{ type: "integer" }, { type: "null" }] }; } },
    { name: "a new status clients must handle", rule: "response-enum-value-added", location: /GET .*orders 200 .*status/, change: (s) => void statusEnum(s).enum.push("RETURNED") },
  ];
  for (const { name, rule, location, change } of breaking) {
    test(`detects ${name}`, () => {
      const found: BreakingChange[] = findBreakingChanges(base, edit(change));
      expect(found.filter((item) => item.rule === rule && location.test(item.location)), JSON.stringify(found.slice(0, 5))).not.toEqual([]);
    });
  }

  const compatible: { name: string; change: (spec: OpenApiDocument) => void }[] = [
    { name: "a new operation", change: (s) => { s.paths["/api/v1/new"] = { get: { responses: { "200": {} } } }; } },
    { name: "a new optional request field", change: (s) => { schema(s, "ProductCreate").properties.colour = { type: "string" }; } },
    { name: "a new response field", change: (s) => { schema(s, "OrderSummaryOut").properties.carrier = { type: "string" }; } },
    { name: "a new optional query parameter", change: (s) => void orders(s).get!.parameters!.push({ name: "carrier", in: "query", schema: { type: "string" } }) },
    { name: "a loosened request limit", change: (s) => void (schema(s, "OrderCreate").properties.items!.maxItems = 500) },
    { name: "a new documented status", change: (s) => { orders(s).post!.responses["429"] = {}; } },
  ];
  for (const { name, change } of compatible) {
    test(`does not report ${name}`, () => {
      expect(findBreakingChanges(base, edit(change))).toEqual([]);
    });
  }
});

test.describe("the contract checker itself", { tag: "@contract" }, () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const product = {
    id, sku: "ABC", name: "n", description: "", category: "c", unit_price_cents: 1, is_active: true, total_quantity: 0,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", stock: [],
  };
  const reply = (status: number, body: unknown, path = `/api/v1/products/${id}`, method = "GET") => ({
    method, path, status, headers: { "content-type": "application/json", "x-request-id": id }, body: JSON.stringify(body),
  });

  test("accepts a valid response", () => {
    expect(contract.checkResponse(reply(200, product))).toEqual([]);
  });

  const invalid: { name: string; response: ReturnType<typeof reply>; expected: RegExp }[] = [
    { name: "an undeclared field such as a password hash", response: reply(200, { ...product, password_hash: "x" }), expected: /additionalProperty.*password_hash/ },
    { name: "a missing required field", response: reply(200, { ...product, sku: undefined }), expected: /required.*sku/ },
    { name: "the wrong type", response: reply(200, { ...product, unit_price_cents: "1" }), expected: /must be integer/ },
    { name: "cents that are not whole", response: reply(200, { ...product, unit_price_cents: 1.5 }), expected: /must be integer/ },
    { name: "a malformed uuid", response: reply(200, { ...product, id: "nope" }), expected: /format.*uuid/ },
    { name: "an undocumented status", response: reply(418, {}), expected: /status is not documented/ },
    { name: "an undocumented path", response: reply(200, {}, "/api/v1/secret"), expected: /not in the OpenAPI spec/ },
    { name: "an undocumented method", response: reply(200, {}, "/api/v1/roles", "DELETE"), expected: /not in the OpenAPI spec/ },
    { name: "an error outside the envelope", response: reply(404, { detail: "Not Found" }), expected: /required.*error/ },
    { name: "an error id that differs from the header", response: reply(404, { error: { code: "X", message: "m", details: [], request_id: "other" } }), expected: /does not match/ },
  ];
  for (const { name, response, expected } of invalid) {
    test(`reports ${name}`, () => {
      expect(contract.checkResponse(response).join("\n")).toMatch(expected);
    });
  }

  test("reports a missing request id and an undocumented content type", () => {
    expect(contract.checkResponse({ ...reply(200, product), headers: { "content-type": "application/json" } }).join()).toMatch(/X-Request-ID/);
    expect(contract.checkResponse({ ...reply(200, product), headers: { "content-type": "text/html", "x-request-id": id } }).join()).toMatch(/content type/);
  });

  test("literal paths win over templated ones", () => {
    expect(contract.find("GET", "/api/v1/orders/export.csv")?.key).toBe("GET /api/v1/orders/export.csv");
    expect(contract.find("GET", "/api/v1/products/categories")?.key).toBe("GET /api/v1/products/categories");
    expect(contract.find("GET", `/api/v1/orders/${id}`)?.key).toBe("GET /api/v1/orders/{order_id}");
  });
});
