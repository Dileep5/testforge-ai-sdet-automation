import { expect, test } from "../../framework/fixtures/api";
import { expectValidationError, readApiError, type ApiClient } from "../../framework/helpers/api-client";
import type { InventoryRow, ProductDetail } from "../../framework/helpers/types";

function stockRow(product: ProductDetail, code = "YYZ1") {
  const row = product.stock.find((item) => item.warehouse.code === code);
  if (!row) throw new Error(`No stock row at ${code}`);
  return row;
}

/** Follow the cursor to the end of the list. */
async function readFrom(api: ApiClient, params: Record<string, string | number>, after: string): Promise<string[]> {
  const { items } = await api.inventory({ ...params, after_id: after });
  const last = items.at(-1)?.id;
  return last ? [...items.map((row) => row.id), ...(await readFrom(api, params, last))] : [];
}

test.describe("inventory", { tag: "@api" }, () => {
  test("list filters by product and warehouse, and reads a single row", async ({ asViewer, data }) => {
    const product = await data.product({ stock: { YYZ1: 7, YVR1: 2 } });
    const warehouse = await data.warehouse("YVR1");
    const all = await asViewer.api.inventory({ product_id: product.id });
    expect(all.total).toBe(4);
    const filtered = await asViewer.api.inventory({ product_id: product.id, warehouse_id: warehouse.id });
    expect(filtered.items.map((row) => row.quantity)).toEqual([2]);
    const one = filtered.items[0];
    expect(one && (await asViewer.api.inventoryRow(one.id))).toEqual(one);
    const bySku = await asViewer.api.inventory({ q: product.sku, sort: "quantity", direction: "desc", page_size: 2 });
    expect(bySku).toMatchObject({ total: 4, pages: 2 });
    expect(bySku.items.map((row) => row.quantity)).toEqual([7, 2]);
  });

  test("the cursor returns every remaining row exactly once while the list changes", async ({ asManager, data }) => {
    const warehouse = await data.warehouse("YYZ1");
    const products = await Promise.all(Array.from({ length: 6 }, () => data.product({ stock: {} })));
    const params = { warehouse_id: warehouse.id, q: data.namespace, sort: "id", page_size: 2 };
    const first = await asManager.api.inventory(params);
    const firstIds = first.items.map((row) => row.id);

    // Rows the reader has passed disappear, and a new one arrives: this makes offset pages skip rows.
    const passed = first.items.map((row) => row.product.id);
    for (const id of passed) await asManager.api.updateProduct(id, { is_active: false });
    await data.product({ stock: {} });

    const seen = [...firstIds, ...(await readFrom(asManager.api, params, firstIds.at(-1) ?? ""))];

    const stillActive = products.filter((product) => !passed.includes(product.id));
    const expected = stillActive.map((product) => product.stock.find((row) => row.warehouse.code === "YYZ1")?.inventory_id);
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of expected) expect(seen).toContain(id);
  });

  test("the cursor refuses to combine with another sort order", async ({ asViewer }) => {
    const id = "00000000-0000-4000-8000-000000000000";
    await expectValidationError(await asViewer.api.send("GET", "/inventory", { params: { after_id: id } }), "query.after_id");
    await expectValidationError(await asViewer.api.send("GET", "/inventory", { params: { after_id: id, sort: "id", direction: "desc" } }), "query.after_id");
  });

  test("low_stock returns only rows at or below the reorder level", async ({ asViewer, data }) => {
    const product = await data.product({ stock: { YYZ1: 10, YVR1: 11, YUL1: 9 } });
    const rows = await asViewer.api.inventory({ product_id: product.id, low_stock: true, page_size: 100 });
    expect(rows.items.map((row) => row.warehouse.code).sort()).toEqual(["YUL1", "YYC1", "YYZ1"]);
    expect(rows.items.every((row) => row.quantity <= row.reorder_level)).toBe(true);
  });

  test("an update sets the quantity and bumps the version", async ({ asManager, data }) => {
    const product = await data.product({ stock: { YYZ1: 5 } });
    const row = stockRow(product);
    const updated = await asManager.api.adjustInventory(row.inventory_id, 12, row.version, "cycle count");
    expect(updated).toMatchObject({ quantity: 12, version: row.version + 1 });
    expect((await asManager.api.product(product.id)).total_quantity).toBe(12);
  });

  test("a stale version is refused, reports the current one, and changes nothing", async ({ asManager, data }) => {
    const product = await data.product({ stock: { YYZ1: 5 } });
    const row = stockRow(product);
    const body = { quantity: 99, expected_version: row.version - 1, reason: "stale edit" };
    const error = await readApiError(await asManager.api.send("PATCH", `/inventory/${row.inventory_id}`, { data: body }), 409, "VERSION_CONFLICT");
    expect(error.details).toEqual([{ expected_version: row.version - 1, current_version: row.version }]);
    expect((await asManager.api.inventoryRow(row.inventory_id)).quantity).toBe(5);
  });

  test("an order changes the version, so an edit prepared before it is refused", async ({ asManager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const row = stockRow(product);
    await data.order({ customer, lines: [{ product, quantity: 2 }] });
    const body = { quantity: 100, expected_version: row.version, reason: "stale after order" };
    await readApiError(await asManager.api.send("PATCH", `/inventory/${row.inventory_id}`, { data: body }), 409, "VERSION_CONFLICT");
    expect((await asManager.api.inventoryRow(row.inventory_id)).quantity).toBe(3);
  });

  test("of two simultaneous edits to one version, exactly one wins", async ({ asManager, data }) => {
    const product = await data.product({ stock: { YYZ1: 5 } });
    const row = stockRow(product);
    const responses = await Promise.all(
      [11, 22].map((quantity) =>
        asManager.api.send("PATCH", `/inventory/${row.inventory_id}`, {
          data: { quantity, expected_version: row.version, reason: "concurrent" },
        }),
      ),
    );
    expect(responses.map((response) => response.status()).sort()).toEqual([200, 409]);
    const winner = responses.find((response) => response.ok());
    const current = await asManager.api.inventoryRow(row.inventory_id);
    expect(current.quantity).toBe(((await winner?.json()) as InventoryRow).quantity);
    expect(current.version).toBe(row.version + 1);
  });

  const invalidUpdates: { name: string; change: Record<string, unknown>; field: string }[] = [
    { name: "a negative quantity", change: { quantity: -1 }, field: "body.quantity" },
    { name: "a quantity above the maximum", change: { quantity: 1_000_000_001 }, field: "body.quantity" },
    { name: "a fractional quantity", change: { quantity: 1.5 }, field: "body.quantity" },
    { name: "a quantity sent as a string", change: { quantity: "5" }, field: "body.quantity" },
    { name: "version 0", change: { expected_version: 0 }, field: "body.expected_version" },
    { name: "a too-short reason", change: { reason: "ab" }, field: "body.reason" },
    { name: "an unknown field", change: { reorder_level: 0 }, field: "body.reorder_level" },
  ];
  for (const { name, change, field } of invalidUpdates) {
    test(`an inventory update rejects ${name}`, async ({ asManager, data }) => {
      const product = await data.product({ stock: { YYZ1: 5 } });
      const row = stockRow(product);
      const body = { quantity: 6, expected_version: row.version, reason: "valid reason" };
      await expectValidationError(await asManager.api.send("PATCH", `/inventory/${row.inventory_id}`, { data: { ...body, ...change } }), field);
      expect((await asManager.api.inventoryRow(row.inventory_id)).quantity).toBe(5);
    });
  }

  test("an unknown row is 404 and a malformed id is 422", async ({ asManager }) => {
    const missing = "00000000-0000-4000-8000-000000000000";
    const body = { quantity: 1, expected_version: 1, reason: "missing" };
    await readApiError(await asManager.api.send("GET", `/inventory/${missing}`), 404, "NOT_FOUND");
    await readApiError(await asManager.api.send("PATCH", `/inventory/${missing}`, { data: body }), 404, "NOT_FOUND");
    await expectValidationError(await asManager.api.send("GET", "/inventory/1"), "path.inventory_id");
  });
});
