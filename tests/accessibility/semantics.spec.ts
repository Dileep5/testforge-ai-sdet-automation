import { expect, test } from "../../framework/fixtures";
import { focusStop, tabThroughPage } from "../../framework/helpers/accessibility";

test.describe("names, labels and error descriptions", { tag: "@accessibility" }, () => {
  test("clicking a label focuses its control", async ({ anon }) => {
    await anon.app.login.goto();
    await anon.page.getByText("Password", { exact: true }).click();
    await expect(anon.app.login.password).toBeFocused();
  });

  test("login errors are described by the field they belong to, and clear when corrected", async ({ anon }) => {
    const { login } = anon.app;
    await login.goto();
    await login.submitButton.click();
    await expect(login.email).toHaveAttribute("aria-invalid", "true");
    await expect(login.email).toHaveAccessibleDescription("Enter your email address");
    await expect(login.password).toHaveAccessibleDescription("Enter your password");
    await login.email.fill("someone@e2e.example");
    await expect(login.email).not.toHaveAttribute("aria-invalid", "true");
    await expect(login.email).toHaveAccessibleDescription("");
  });

  test("authentication and server errors are announced as alerts", async ({ anon }) => {
    await anon.app.login.goto();
    await anon.app.login.signIn({ email: "nobody@e2e.example", password: "wrong-password" });
    await expect(anon.page.getByRole("alert")).toHaveText("Incorrect email or password");
  });

  test("hints stay in the description alongside an error", async ({ manager, data }) => {
    const product = await data.product({ stock: { YYZ1: 5 } });
    const { inventory } = manager.app;
    await inventory.goto();
    await inventory.search(product.sku);
    await inventory.adjustButton(product.sku, "YYZ1").click();
    await expect(inventory.reason).toHaveAccessibleDescription("Saved in the audit log.");
    await inventory.adjustModal.button("Save quantity").click();
    await expect(inventory.reason).toHaveAccessibleDescription(/Saved in the audit log\..*reason/);
  });

  test("order lines have distinct names, and their errors are tied to the right line", async ({ manager }) => {
    const { newOrder } = manager.app;
    const { page } = manager;
    await newOrder.goto();
    await newOrder.addLine();
    await expect(newOrder.product(1)).toBeVisible();
    await expect(newOrder.product(2)).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove line 2" })).toBeVisible();
    await newOrder.submitButton.click();
    await expect(newOrder.product(2)).toHaveAttribute("aria-invalid", "true");
    await expect(newOrder.product(2)).not.toHaveAccessibleDescription("");
    await expect(newOrder.quantity(1)).not.toHaveAttribute("aria-invalid", "true");
  });

  test("grids expose sort state and have a name", async ({ manager }) => {
    const { orders } = manager.app;
    const { page } = manager;
    await orders.goto();
    await expect(page.getByRole("region", { name: "Orders table" })).toBeVisible();
    await expect(orders.grid.table.locator('th[aria-sort="descending"]')).toContainText("Date");
    await expect(orders.grid.table.locator('th[aria-sort="none"]').first()).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Pagination" })).toBeVisible();
  });

  test("status is conveyed in text, not only by color", async ({ manager }) => {
    await manager.app.orders.goto("?status=CANCELLED");
    await expect(manager.page.getByTestId("status-badge").first()).toHaveText("Cancelled");
  });

  test("the page language is declared and the title identifies the app", async ({ anon }) => {
    await anon.app.login.goto();
    await expect(anon.page.locator("html")).toHaveAttribute("lang", /^en/);
    await expect(anon.page).toHaveTitle(/TestForge/);
  });
});

test.describe("dialogs", { tag: "@accessibility" }, () => {
  test("each dialog has the dialog role, a name, and focus inside", async ({ admin, data }) => {
    const product = await data.product({ stock: { YYZ1: 5 } });
    const { page, app } = admin;

    await app.products.goto();
    await app.products.newProductButton.click();
    await expect(page.getByRole("dialog", { name: "New product" })).toBeVisible();
    await app.products.newProductModal.expectOpenWithFocusInside();
    await app.products.newProductModal.closeWithEscape();

    await app.inventory.goto();
    await app.inventory.search(product.sku);
    await app.inventory.adjustButton(product.sku, "YYZ1").click();
    await expect(page.getByRole("dialog", { name: `Adjust ${product.sku} at YYZ1` })).toBeVisible();
    await app.inventory.adjustModal.expectOpenWithFocusInside();
    await app.inventory.adjustModal.closeWithEscape();

    await app.productDetails.goto(product.id);
    await page.getByRole("button", { name: "Retire" }).click();
    await expect(page.getByRole("dialog", { name: "Retire product" })).toBeVisible();
    await app.productDetails.retireModal.expectOpenWithFocusInside();
  });

  test("the page behind an open dialog cannot be reached", async ({ manager }) => {
    const { products } = manager.app;
    await products.goto();
    await products.newProductButton.click();
    await products.newProductModal.expectOpenWithFocusInside();
    // A modal dialog makes the rest of the document inert, for mouse, keyboard and screen readers.
    expect(await products.newProductModal.root.evaluate((dialog) => dialog.matches(":modal"))).toBe(true);
  });

  test("the close button has an accessible name", async ({ manager }) => {
    const { products } = manager.app;
    await products.goto();
    await products.newProductButton.click();
    await expect(products.newProductModal.root.getByRole("button", { name: "Close" })).toBeVisible();
  });
});

test.describe("focus visibility", { tag: "@accessibility" }, () => {
  test("every stop on the login page shows a focus indicator", async ({ anon }) => {
    await anon.app.login.goto();
    const stops = await tabThroughPage(anon.page, 6);
    expect(stops.length).toBeGreaterThanOrEqual(3);
    expect(stops.filter((stop) => !stop.visibleIndicator || !stop.inViewport)).toEqual([]);
  });

  const pages = [
    { name: "dashboard", path: "/", testId: "stat-total-orders" },
    { name: "orders", path: "/orders", testId: "orders-grid" },
    { name: "products", path: "/products", testId: "products-grid" },
    { name: "inventory", path: "/inventory", testId: "inventory-grid" },
    { name: "new order", path: "/orders/new", testId: "preview-total" },
  ];
  for (const { name, path, testId } of pages) {
    test(`every stop on ${name} shows a focus indicator`, async ({ manager }) => {
      await manager.page.goto(path);
      await expect(manager.page.getByTestId(testId)).toBeVisible();
      const stops = await tabThroughPage(manager.page, 40);
      expect(stops.length).toBeGreaterThanOrEqual(5);
      expect(stops.filter((stop) => !stop.visibleIndicator)).toEqual([]);
    });
  }

  test("stops inside a dialog show a focus indicator", async ({ manager }) => {
    const { products } = manager.app;
    const { page } = manager;
    await products.goto();
    await products.newProductButton.focus();
    await page.keyboard.press("Enter");
    await expect(products.newProductModal.field("SKU")).toBeFocused();
    expect(await focusStop(page)).toMatchObject({ visibleIndicator: true });
    const stops = await tabThroughPage(page, 7);
    expect(stops.filter((stop) => !stop.visibleIndicator)).toEqual([]);
  });

  test("the skip link is visible when focused", async ({ manager }) => {
    await manager.page.goto("/");
    await expect(manager.page.getByTestId("stat-total-orders")).toBeVisible();
    await manager.page.keyboard.press("Tab");
    const skip = manager.page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    expect(await focusStop(manager.page)).toMatchObject({ visibleIndicator: true, inViewport: true });
  });
});
