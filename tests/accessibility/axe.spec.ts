import { expect, test, type RoleSession } from "../../framework/fixtures";
import type { TestData } from "../../framework/factories/test-data";
import { expectAccessiblePage } from "../../framework/helpers/accessibility";
import { expireSession } from "../../framework/helpers/database";
import type { OrderDetail } from "../../framework/helpers/types";

async function pendingOrder(data: TestData): Promise<OrderDetail> {
  const customer = await data.customer();
  const product = await data.product({ stock: { YYZ1: 5 } });
  return data.order({ customer, lines: [{ product, quantity: 1 }] });
}

test.describe("axe: sign in", { tag: "@accessibility" }, () => {
  test("login form", async ({ anon }) => {
    await anon.app.login.goto();
    await expectAccessiblePage(anon.page, "login");
  });

  test("login with validation errors", async ({ anon }) => {
    await anon.app.login.goto();
    await anon.app.login.submitButton.click();
    await expect(anon.page.getByText("Enter your email address")).toBeVisible();
    await expectAccessiblePage(anon.page, "login-validation");
  });

  test("login with an authentication error", async ({ anon }) => {
    await anon.app.login.goto();
    await anon.app.login.signIn({ email: "nobody@e2e.example", password: "wrong-password" });
    await expect(anon.app.login.error).toBeVisible();
    await expectAccessiblePage(anon.page, "login-auth-error");
  });

  test("login after the session ended", async ({ data, signIn }) => {
    const { app, page, sessionCookie } = await signIn(await data.user("VIEWER"));
    await app.dashboard.goto();
    await expireSession(await sessionCookie());
    await page.reload();
    await expect(page).toHaveURL(/\/login/);
    await expectAccessiblePage(page, "login-session-ended");
  });
});

test.describe("axe: dashboard and orders", { tag: "@accessibility" }, () => {
  test("dashboard", async ({ manager }) => {
    await manager.app.dashboard.goto();
    await expectAccessiblePage(manager.page, "dashboard");
  });

  test("orders grid, with every status badge", async ({ manager }) => {
    await manager.app.orders.goto();
    await expect(manager.app.orders.grid.rows.first()).toBeVisible();
    await expectAccessiblePage(manager.page, "orders");
  });

  test("orders with no results", async ({ manager }) => {
    await manager.app.orders.goto("?q=no-such-order");
    await expect(manager.app.orders.emptyState).toBeVisible();
    await expectAccessiblePage(manager.page, "orders-empty");
  });

  test("order details with a payment form", async ({ manager, data }) => {
    const order = await pendingOrder(data);
    await manager.app.orderDetails.goto(order.id);
    await expect(manager.app.orderDetails.paymentForm).toBeVisible();
    await expectAccessiblePage(manager.page, "order-details");
  });

  test("order details after a declined payment", async ({ manager, data }) => {
    const order = await pendingOrder(data);
    const { orderDetails } = manager.app;
    await orderDetails.goto(order.id);
    await orderDetails.runPayment("Simulated: declined");
    await expect(orderDetails.paymentRows).toHaveCount(1);
    await expectAccessiblePage(manager.page, "order-details-declined");
  });

  test("order details for a finished order", async ({ manager, data }) => {
    const order = await data.advance(await pendingOrder(data), "DELIVERED");
    await manager.app.orderDetails.goto(order.id);
    await expectAccessiblePage(manager.page, "order-details-delivered");
  });

  test("order status dialog", async ({ manager, data }) => {
    const order = await pendingOrder(data);
    const { orderDetails } = manager.app;
    const { page } = manager;
    await orderDetails.goto(order.id);
    await page.getByTestId("order-actions").getByRole("button", { name: "Cancel order" }).click();
    await orderDetails.statusModal.expectOpenWithFocusInside();
    await expectAccessiblePage(page, "status-dialog");
  });

  test("order status dialog with a server error", async ({ manager, data }) => {
    const order = await pendingOrder(data);
    const { orderDetails } = manager.app;
    await orderDetails.goto(order.id);
    await orderDetails.attemptTransition("Confirm order");
    await expect(orderDetails.statusError).toBeVisible();
    await expectAccessiblePage(manager.page, "status-dialog-error");
  });

  test("new order form", async ({ manager }) => {
    await manager.app.newOrder.goto();
    await expectAccessiblePage(manager.page, "new-order");
  });

  test("new order with validation errors", async ({ manager }) => {
    const { newOrder } = manager.app;
    await newOrder.goto();
    await newOrder.submitButton.click();
    await expect(newOrder.customer).toHaveAttribute("aria-invalid", "true");
    await expectAccessiblePage(manager.page, "new-order-validation");
  });

  test("new order with a stock error from the server", async ({ manager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const { newOrder } = manager.app;
    await newOrder.goto();
    await newOrder.selectCustomer(customer.name);
    await newOrder.selectWarehouse("YYZ1");
    await newOrder.setLine(1, product.sku, 2);
    await data.order({ customer, lines: [{ product, quantity: 4 }] });
    await newOrder.submit();
    await expect(newOrder.error).toBeVisible();
    await expectAccessiblePage(manager.page, "new-order-server-error");
  });
});

test.describe("axe: products and inventory", { tag: "@accessibility" }, () => {
  test("products grid", async ({ manager }) => {
    await manager.app.products.goto();
    await expect(manager.app.products.grid.rows.first()).toBeVisible();
    await expectAccessiblePage(manager.page, "products");
  });

  test("new product dialog", async ({ manager }) => {
    const { products } = manager.app;
    await products.goto();
    await products.newProductButton.click();
    await products.newProductModal.expectOpenWithFocusInside();
    await expectAccessiblePage(manager.page, "new-product-dialog");
  });

  test("new product dialog with validation errors", async ({ manager }) => {
    const { products } = manager.app;
    await products.goto();
    await products.newProductButton.click();
    await products.newProductModal.button("Create product").click();
    await expect(products.newProductModal.field("SKU")).toHaveAttribute("aria-invalid", "true");
    await expectAccessiblePage(manager.page, "new-product-validation");
  });

  test("product details and its dialogs", async ({ admin, data }) => {
    const product = await data.product({ stock: { YYZ1: 5 } });
    const { productDetails } = admin.app;
    await productDetails.goto(product.id);
    await expectAccessiblePage(admin.page, "product-details");

    await admin.page.getByRole("button", { name: "Edit" }).click();
    await productDetails.editModal.expectOpenWithFocusInside();
    await expectAccessiblePage(admin.page, "edit-product-dialog");
    await productDetails.editModal.closeWithEscape();

    await admin.page.getByRole("button", { name: "Retire" }).click();
    await productDetails.retireModal.expectOpenWithFocusInside();
    await expectAccessiblePage(admin.page, "retire-product-dialog");
  });

  test("inventory grid", async ({ manager }) => {
    await manager.app.inventory.goto();
    await expect(manager.app.inventory.grid.rows.first()).toBeVisible();
    await expectAccessiblePage(manager.page, "inventory");
  });

  test("inventory dialog, with errors, and the success message", async ({ manager, data }) => {
    const product = await data.product({ stock: { YYZ1: 5 } });
    const { inventory } = manager.app;
    await inventory.goto();
    await inventory.search(product.sku);
    await inventory.adjustButton(product.sku, "YYZ1").click();
    await inventory.adjustModal.expectOpenWithFocusInside();
    await expectAccessiblePage(manager.page, "adjust-dialog");

    await inventory.newQuantity.fill("-1");
    await inventory.adjustModal.button("Save quantity").click();
    await expect(inventory.newQuantity).toHaveAttribute("aria-invalid", "true");
    await expectAccessiblePage(manager.page, "adjust-validation");

    await inventory.newQuantity.fill("9");
    await inventory.reason.fill("accessibility scan");
    await inventory.submitAdjustment();
    await inventory.toasts.expectSuccess(/./);
    await expectAccessiblePage(manager.page, "inventory-toast");
  });
});

test.describe("axe: other screens and roles", { tag: "@accessibility" }, () => {
  test("users and audit log", async ({ admin }) => {
    await admin.app.users.goto();
    await expectAccessiblePage(admin.page, "users");
    await admin.page.getByRole("button", { name: "New user" }).click();
    await expectAccessiblePage(admin.page, "new-user-dialog");
    await admin.page.keyboard.press("Escape");
    await admin.app.audit.goto();
    await expectAccessiblePage(admin.page, "audit");
  });

  test("access denied and not found", async ({ viewer }) => {
    await viewer.page.goto("/admin/users");
    await expect(viewer.page.getByTestId("forbidden")).toBeVisible();
    await expectAccessiblePage(viewer.page, "forbidden");
    await viewer.page.goto("/no-such-page");
    await expect(viewer.page.getByTestId("empty-state")).toBeVisible();
    await expectAccessiblePage(viewer.page, "not-found");
  });

  test("order not found", async ({ manager }) => {
    await manager.page.goto("/orders/00000000-0000-4000-8000-000000000000");
    await expect(manager.app.orderDetails.notFound).toBeVisible();
    await expectAccessiblePage(manager.page, "order-not-found");
  });

  test("a customer-scoped buyer's view", async ({ buyer, data }) => {
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer: buyer.customer, lines: [{ product, quantity: 1 }] });
    await buyer.app.dashboard.goto();
    await expectAccessiblePage(buyer.page, "buyer-dashboard");
    await buyer.app.orderDetails.goto(order.id);
    await expectAccessiblePage(buyer.page, "buyer-order");
  });

  const narrow: { name: string; open: (session: RoleSession) => Promise<void> }[] = [
    { name: "dashboard", open: (session) => session.app.dashboard.goto() },
    { name: "orders", open: (session) => session.app.orders.goto() },
    { name: "new order", open: (session) => session.app.newOrder.goto() },
    { name: "inventory", open: (session) => session.app.inventory.goto() },
  ];
  for (const { name, open } of narrow) {
    test(`${name} at 320px wide reflows without page-level horizontal scrolling`, async ({ manager }) => {
      await manager.page.setViewportSize({ width: 320, height: 640 });
      await open(manager);
      await expectAccessiblePage(manager.page, `narrow-${name}`);
      const overflow = await manager.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, "pixels of horizontal overflow").toBeLessThanOrEqual(0);
    });
  }
});
