import { expect, test } from "../../framework/fixtures";
import { expectApiError } from "../../framework/helpers/api-client";

test.describe("products", { tag: "@regression" }, () => {
  test("search, category and availability filters return the right products", { tag: "@smoke" }, async ({ manager, data }) => {
    const category = `Cat ${data.namespace}`;
    const stocked = await data.product({ category, name: `Widget ${data.namespace} A`, stock: { YYZ1: 7, YYC1: 3 } });
    const empty = await data.product({ category, name: `Widget ${data.namespace} B`, stock: {} });
    await data.product({ name: `Other ${data.namespace}` });
    const { products } = manager.app;

    await products.goto();
    await products.search(`Widget ${data.namespace}`);
    await expect(await products.grid.column("SKU")).toHaveText([stocked.sku, empty.sku]);
    await expect(await products.grid.column("In stock")).toHaveText(["10", "0"]);

    await products.filterAvailability("Out of stock");
    await expect(await products.grid.column("SKU")).toHaveText([empty.sku]);
    await products.filterAvailability("In stock");
    await expect(await products.grid.column("SKU")).toHaveText([stocked.sku]);

    await products.filterCategory(category);
    await expect(await products.grid.column("Category")).toHaveText([category]);

    await products.search("no-such-product-anywhere");
    await expect(products.emptyState).toContainText("No products found");
  });

  test("sorting by price orders the search results by the numeric amount", async ({ viewer, data }) => {
    // 9.00 sorts after 100.00 as text, so this catches price sorted as a string.
    const name = `Priced ${data.namespace}`;
    const nine = await data.product({ name: `${name} 1`, priceCents: 900 });
    const hundred = await data.product({ name: `${name} 2`, priceCents: 10000 });
    const twenty = await data.product({ name: `${name} 3`, priceCents: 2000 });
    const { products } = viewer.app;
    await products.goto();
    await products.search(name);
    await products.grid.sortBy("Unit price", "unit_price_cents", "asc");
    await expect(await products.grid.column("SKU")).toHaveText([nine.sku, twenty.sku, hundred.sku]);
    await products.grid.sortBy("Unit price", "unit_price_cents", "desc");
    await expect(await products.grid.column("SKU")).toHaveText([hundred.sku, twenty.sku, nine.sku]);
  });

  test("a product created in the UI stores its price as exact integer cents", { tag: "@critical" }, async ({ manager, data, db, setupApi }) => {
    const sku = `NEW-${data.namespace}`;
    const { app, page } = manager;
    const { products, productDetails } = app;
    await products.goto();
    // 19.99 and 1.10 are classic values that binary floats cannot represent exactly.
    await products.fillNewProduct({ sku, name: `Created ${data.namespace}`, category: "E2E", price: "19.99" });
    await products.submitNewProduct();

    await products.toasts.expectSuccess(`Product ${sku} created`);
    await expect(page).toHaveURL(/\/products\/[0-9a-f-]{36}$/);
    await expect(productDetails.price).toHaveText("$19.99");
    await expect(productDetails.totalStock).toHaveText("0");
    await expect(productDetails.stockRows).toHaveCount(4);

    const stored = await db.product(sku);
    expect(stored?.unit_price_cents).toBe(1999);

    await productDetails.changePrice("1.10");
    await productDetails.toasts.expectSuccess("Product updated");
    await expect(productDetails.price).toHaveText("$1.10");
    expect((await db.product(sku))?.unit_price_cents).toBe(110);
    await setupApi.retireProduct(stored?.id ?? "");
  });

  test("a duplicate SKU and an invalid price are refused with clear messages", async ({ manager, data }) => {
    const existing = await data.product();
    const { products } = manager.app;
    const modal = products.newProductModal;
    await products.goto();
    await products.fillNewProduct({ sku: existing.sku, name: "Duplicate", category: "E2E", price: "19.999" });
    await modal.button("Create product").click();
    const priceError = modal.root.getByText("Enter a price such as 19.99");
    await expect(priceError).toBeVisible();

    await modal.field("Unit price (CAD)").fill("19.99");
    await expect(priceError).toBeHidden();
    await products.submitNewProduct();
    await expect(modal.root.getByRole("alert")).toContainText(`A product with SKU ${existing.sku} already exists`);
  });

  test("changing a price leaves existing orders untouched", { tag: "@critical" }, async ({ manager, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ priceCents: 1000, stock: { YYZ1: 10 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 2 }] });
    const { productDetails, orderDetails } = manager.app;

    await productDetails.goto(product.id);
    await productDetails.changePrice("99.00");
    await expect(productDetails.price).toHaveText("$99.00");

    await orderDetails.goto(order.id);
    expect((await orderDetails.totals()).subtotalCents).toBe(2000);
    expect((await db.order(order.order_number)).total_cents).toBe(2260);
    expect((await db.orderItems(order.id))[0]?.unit_price_cents).toBe(1000);
  });

  test("only an admin can retire a product, after which it cannot be ordered", { tag: "@critical" }, async ({ admin, manager, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 10 } });

    await manager.app.productDetails.goto(product.id);
    await expect(manager.app.productDetails.editButton).toBeVisible();
    await expect(manager.app.productDetails.retireButton).toHaveCount(0);
    await expectApiError(await manager.api.send("DELETE", `/products/${product.id}`), 403, "FORBIDDEN");
    expect((await db.product(product.sku))?.is_active).toBe(true);

    await admin.app.productDetails.goto(product.id);
    await admin.app.productDetails.retire();
    await admin.app.productDetails.toasts.expectSuccess("Product retired");
    await expect(admin.app.productDetails.retireButton).toHaveCount(0);
    expect((await db.product(product.sku))?.is_active).toBe(false);

    await manager.app.newOrder.goto();
    await manager.app.newOrder.selectCustomer(customer.name);
    await manager.app.newOrder.selectWarehouse("YYZ1");
    await expect(manager.app.newOrder.product(1).locator("option", { hasText: product.sku })).toHaveCount(0);
    const warehouse = await data.warehouse("YYZ1");
    await expectApiError(
      await manager.api.send("POST", "/orders", {
        data: { customer_id: customer.id, warehouse_id: warehouse.id, items: [{ product_id: product.id, quantity: 1 }] },
      }),
      422,
      "INVALID_REFERENCE",
    );
  });
});

test.describe("dashboard", { tag: "@regression" }, () => {
  test("figures reflect real orders, and each status links to a filtered list", { tag: "@smoke" }, async ({ buyer, data }) => {
    const product = await data.product({ priceCents: 1000, stock: { YYZ1: 20 } });
    const pending = await data.order({ customer: buyer.customer, lines: [{ product, quantity: 1 }] });
    const shipped = await data.advance(await data.order({ customer: buyer.customer, lines: [{ product, quantity: 2 }] }), "SHIPPED");
    const { app } = buyer;

    await app.dashboard.goto();
    await expect(app.dashboard.totalOrders).toHaveText("2");
    await expect(app.dashboard.openOrders).toHaveText("2");
    await expect(app.dashboard.settledRevenue).toHaveText("$22.60");
    await expect(app.dashboard.recentOrders).toHaveCount(2);

    await app.page.getByRole("link", { name: /Pending/ }).click();
    await expect(app.page).toHaveURL(/\/orders\?status=PENDING$/);
    await expect(await app.orders.grid.column("Order")).toHaveText([pending.order_number]);
    await expect(app.orders.status).toHaveValue("PENDING");
    expect(shipped.status).toBe("SHIPPED");
  });
});
