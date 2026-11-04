import { expect, test } from "../../framework/fixtures/api";
import { expectValidationError, readApiError } from "../../framework/helpers/api-client";
import type { ProductDetail } from "../../framework/helpers/types";

const MISSING = "00000000-0000-4000-8000-000000000000";

test.describe("products", { tag: "@api" }, () => {
  test("create, read, partially update and retire", async ({ asManager, asAdmin, data }) => {
    const sku = data.unique("SKU");
    const created = await asManager.api.send("POST", "/products", {
      data: { sku, name: "  Bolt  ", category: "Hardware", unit_price_cents: 1999 },
    });
    expect(created.status()).toBe(201);
    const product = (await created.json()) as ProductDetail;
    expect(product).toMatchObject({ sku, name: "Bolt", description: "", unit_price_cents: 1999, is_active: true, total_quantity: 0 });
    expect(product.stock.map((row) => [row.warehouse.code, row.quantity, row.version])).toEqual([
      ["YUL1", 0, 1],
      ["YVR1", 0, 1],
      ["YYC1", 0, 1],
      ["YYZ1", 0, 1],
    ]);

    const patched = await asManager.api.updateProduct(product.id, { unit_price_cents: 2500 });
    expect(patched).toMatchObject({ name: "Bolt", category: "Hardware", unit_price_cents: 2500 });
    expect(Date.parse(patched.updated_at)).toBeGreaterThan(Date.parse(product.updated_at));

    expect((await asAdmin.api.send("DELETE", `/products/${product.id}`)).status()).toBe(204);
    expect((await asManager.api.product(product.id)).is_active).toBe(false);
    expect((await asManager.api.products({ q: sku })).total).toBe(0);
    expect((await asManager.api.products({ q: sku, include_inactive: true })).total).toBe(1);
    expect((await asManager.api.inventory({ q: sku })).total).toBe(0);
  });

  test("retiring is safe to repeat, and unknown ids are 404", async ({ asAdmin, data }) => {
    const product = await data.product();
    await asAdmin.api.retireProduct(product.id);
    expect((await asAdmin.api.send("DELETE", `/products/${product.id}`)).status()).toBe(204);
    await readApiError(await asAdmin.api.send("DELETE", `/products/${MISSING}`), 404, "NOT_FOUND");
    await readApiError(await asAdmin.api.send("GET", `/products/${MISSING}`), 404, "NOT_FOUND");
    await readApiError(await asAdmin.api.send("PATCH", `/products/${MISSING}`, { data: { name: "x" } }), 404, "NOT_FOUND");
    await expectValidationError(await asAdmin.api.send("GET", "/products/not-a-uuid"), "path.product_id");
  });

  test("a duplicate SKU conflicts", async ({ asManager, data }) => {
    const { sku } = await data.product();
    const response = await asManager.api.send("POST", "/products", { data: { sku, name: "Copy", category: "E2E", unit_price_cents: 1 } });
    await readApiError(response, 409, "DUPLICATE_SKU");
  });

  const invalidProducts: { name: string; change: Record<string, unknown>; field: string }[] = [
    { name: "a lowercase SKU", change: { sku: "abc-1" }, field: "body.sku" },
    { name: "a too-short SKU", change: { sku: "AB" }, field: "body.sku" },
    { name: "a negative price", change: { unit_price_cents: -1 }, field: "body.unit_price_cents" },
    { name: "a fractional price", change: { unit_price_cents: 19.99 }, field: "body.unit_price_cents" },
    { name: "a price sent as a string", change: { unit_price_cents: "1999" }, field: "body.unit_price_cents" },
    { name: "a boolean price", change: { unit_price_cents: true }, field: "body.unit_price_cents" },
    { name: "a price above the maximum", change: { unit_price_cents: 10_000_000_001 }, field: "body.unit_price_cents" },
    { name: "a blank name", change: { name: "   " }, field: "body.name" },
    { name: "an oversized name", change: { name: "x".repeat(201) }, field: "body.name" },
    { name: "an unknown field", change: { id: MISSING }, field: "body.id" },
  ];
  for (const { name, change, field } of invalidProducts) {
    test(`creating a product rejects ${name}`, async ({ asManager, data }) => {
      const body = { sku: data.unique("SKU"), name: "Bolt", category: "E2E", unit_price_cents: 100 };
      await expectValidationError(await asManager.api.send("POST", "/products", { data: { ...body, ...change } }), field);
    });
  }

  test("creating a product reports every missing required field", async ({ asManager }) => {
    await expectValidationError(await asManager.api.send("POST", "/products", { data: {} }), "body.sku", "body.name", "body.category", "body.unit_price_cents");
  });

  test("pagination covers every record exactly once", async ({ asManager, data }) => {
    const category = data.unique("Page");
    const created = await Promise.all(Array.from({ length: 5 }, () => data.product({ category, stock: {} })));
    const first = await asManager.api.products({ category, page_size: 2, sort: "sku" });
    expect(first).toMatchObject({ total: 5, page: 1, page_size: 2, pages: 3 });
    const pages = [first, await asManager.api.products({ category, page_size: 2, page: 2, sort: "sku" }), await asManager.api.products({ category, page_size: 2, page: 3, sort: "sku" })];
    expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1]);
    expect(pages.flatMap((page) => page.items.map((item) => item.sku))).toEqual(created.map((item) => item.sku).sort());
    const beyond = await asManager.api.products({ category, page_size: 2, page: 4 });
    expect(beyond).toMatchObject({ items: [], total: 5, pages: 3, page: 4 });
    const none = await asManager.api.products({ category: data.unique("Nothing") });
    expect(none).toMatchObject({ items: [], total: 0, pages: 0 });
  });

  test("sorting is numeric for prices and honours direction", async ({ asManager, data }) => {
    const category = data.unique("Sort");
    for (const priceCents of [900, 10000, 2000]) await data.product({ category, priceCents, stock: {} });
    const prices = async (direction: string) =>
      (await asManager.api.products({ category, sort: "unit_price_cents", direction })).items.map((item) => item.unit_price_cents);
    expect(await prices("asc")).toEqual([900, 2000, 10000]);
    expect(await prices("desc")).toEqual([10000, 2000, 900]);
  });

  test("filters: text, category, stock and retired products", async ({ asManager, asViewer, data }) => {
    const category = data.unique("Filter");
    const stocked = await data.product({ category, name: `Widget ${data.namespace}`, stock: { YYZ1: 3 } });
    const empty = await data.product({ category, name: `Gadget ${data.namespace}`, stock: {} });
    const retired = await data.product({ category, name: `Retired ${data.namespace}`, stock: {} });
    await asManager.api.updateProduct(retired.id, { is_active: false });
    const skus = async (params: Record<string, string | boolean>) => (await asManager.api.products({ category, ...params })).items.map((item) => item.sku);

    expect(await skus({ q: `widget ${data.namespace.toLowerCase()}` })).toEqual([stocked.sku]);
    expect(await skus({ q: stocked.sku.toLowerCase() })).toEqual([stocked.sku]);
    expect(await skus({ in_stock: true })).toEqual([stocked.sku]);
    expect(await skus({ in_stock: false })).toEqual([empty.sku]);
    expect((await skus({ include_inactive: true })).sort()).toEqual([stocked.sku, empty.sku, retired.sku].sort());
    expect((await asViewer.api.products({ category, include_inactive: true })).total).toBe(2);
    expect(await asManager.api.categories()).toContain(category);
  });

  test("% and _ in a search are literal characters, not wildcards", async ({ asManager, data }) => {
    const prefix = data.namespace;
    const percent = await data.product({ name: `${prefix} 100% wool`, stock: {} });
    await data.product({ name: `${prefix} 100X wool`, stock: {} });
    const search = async (q: string) => (await asManager.api.products({ q })).items.map((item) => item.sku);
    expect(await search(`${prefix} 100%`)).toEqual([percent.sku]);
    expect(await search(`${prefix} 10_`)).toEqual([]);
  });

  const invalidQueries: { name: string; params: Record<string, string | number>; field: string }[] = [
    { name: "page 0", params: { page: 0 }, field: "query.page" },
    { name: "a page above the maximum", params: { page: 100_001 }, field: "query.page" },
    { name: "a non-numeric page", params: { page: "one" }, field: "query.page" },
    { name: "page_size 0", params: { page_size: 0 }, field: "query.page_size" },
    { name: "page_size above 100", params: { page_size: 101 }, field: "query.page_size" },
    { name: "an unknown sort column", params: { sort: "password_hash" }, field: "query.sort" },
    { name: "an unknown direction", params: { direction: "sideways" }, field: "query.direction" },
    { name: "a non-boolean in_stock", params: { in_stock: "maybe" }, field: "query.in_stock" },
    { name: "an oversized search", params: { q: "x".repeat(101) }, field: "query.q" },
  ];
  for (const { name, params, field } of invalidQueries) {
    test(`listing products rejects ${name}`, async ({ asViewer }) => {
      await expectValidationError(await asViewer.api.send("GET", "/products", { params }), field);
    });
  }
});
