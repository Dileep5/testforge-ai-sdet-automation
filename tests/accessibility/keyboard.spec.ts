import type { Page } from "@playwright/test";
import { expect, test } from "../../framework/fixtures";
import { expectFocusNotLost, focusStop } from "../../framework/helpers/accessibility";
import { whileWaitingFor } from "../../framework/helpers/network";

// Runs in Chromium and WebKit. Firefox has a project too, but cannot launch on this machine.

/** On macOS, WebKit only tabs to fields unless Option is held. Other browsers, and WebKit on Linux, tab to everything. */
function tab(page: Page, browserName: string, reverse = false): Promise<void> {
  const option = browserName === "webkit" && process.platform === "darwin" ? "Alt+" : "";
  return page.keyboard.press(`${option}${reverse ? "Shift+" : ""}Tab`);
}

/** Press Tab from the top of the page until focus leaves it, naming each stop. */
async function tabUntilEnd(page: Page, browserName: string, maxStops: number): Promise<string[]> {
  const stops: string[] = [];
  for (let index = 0; index < maxStops; index++) {
    await tab(page, browserName);
    const stop = await focusStop(page);
    if (!stop) break;
    stops.push(stop.description);
  }
  return stops;
}

test.describe("keyboard: navigation order", { tag: "@keyboard" }, () => {
  test("Tab moves forward through login, and Shift+Tab moves back", async ({ anon, browserName }) => {
    const { login } = anon.app;
    const { page } = anon;
    await login.goto();
    await tab(page, browserName);
    await expect(login.email).toBeFocused();
    await tab(page, browserName);
    await expect(login.password).toBeFocused();
    await tab(page, browserName);
    await expect(login.submitButton).toBeFocused();
    await tab(page, browserName, true);
    await expect(login.password).toBeFocused();
    await tab(page, browserName, true);
    await expect(login.email).toBeFocused();
  });

  test("the skip link moves focus past the navigation", async ({ manager, browserName }) => {
    const { page } = manager;
    await manager.app.dashboard.goto();
    await tab(page, browserName);
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
  });

  test("Tab reaches sort headers, row actions and pagination, without a mouse", async ({ manager, data, browserName }) => {
    const product = await data.product({ stock: { YYZ1: 5 } });
    const { inventory } = manager.app;
    const { page } = manager;
    await inventory.goto();
    await inventory.search(product.sku);
    const reached = await tabUntilEnd(page, browserName, 60);
    expect(reached.join("|")).toContain("Quantity");
    expect(reached.join("|")).toContain(`Adjust ${product.sku} at YYZ1`);
    expect(reached.join("|")).toContain("Next");
  });

  test("navigating by keyboard moves focus to the new page's content", async ({ manager }) => {
    const { page, app } = manager;
    await app.dashboard.goto();
    await page.getByTestId("main-nav").getByRole("link", { name: "Products" }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/products$/);
    await expect(page.getByRole("main")).toBeFocused();
  });

  test("Tab and Shift+Tab move through the filter dropdowns in order", async ({ manager, browserName }) => {
    const { orders } = manager.app;
    const { page } = manager;
    await orders.goto();
    await orders.warehouse.focus();
    await tab(page, browserName);
    await expect(orders.customer).toBeFocused();
    await tab(page, browserName);
    await expect(orders.status).toBeFocused();
    await tab(page, browserName, true);
    await expect(orders.customer).toBeFocused();
  });
});

test.describe("keyboard: activation", { tag: "@keyboard" }, () => {
  test("the support question can be asked using only the keyboard", async ({ viewer, browserName }) => {
    const { support } = viewer.app;
    const { page } = viewer;
    await support.goto();
    await support.question.focus();
    await page.keyboard.type("How long do refunds take?");
    await tab(page, browserName);
    await expect(support.submit).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(support.answer).toContainText("5 business days");
    await expect(support.submit).toBeFocused();
  });

  test("Enter submits the login form from a field", async ({ anon }) => {
    const { login } = anon.app;
    const { page } = anon;
    await login.goto();
    await login.email.fill("nobody@e2e.example");
    await login.password.fill("wrong-password");
    await whileWaitingFor(page, { method: "POST", path: "/auth/login" }, () => login.password.press("Enter"));
    await expect(login.error).toBeVisible();
  });

  for (const key of ["Enter", "Space"]) {
    test(`${key} activates a button`, async ({ manager }) => {
      const { products } = manager.app;
    const { page } = manager;
      await products.goto();
      await products.newProductButton.focus();
      await page.keyboard.press(key);
      await products.newProductModal.expectOpenWithFocusInside();
    });

    test(`${key} activates a sort header, and focus stays on it`, async ({ manager }) => {
      const { products } = manager.app;
    const { page } = manager;
      await products.goto();
      const header = products.grid.table.getByRole("button", { name: "Unit price" });
      await header.focus();
      await whileWaitingFor(page, { method: "GET", path: "/products", params: { sort: "unit_price_cents" } }, () => page.keyboard.press(key));
      await expect(products.grid.table.locator('th[aria-sort="ascending"]')).toContainText("Unit price");
      await expect(header).toBeFocused();
    });
  }

  test("Enter follows a link", async ({ manager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { orders } = manager.app;
    const { page } = manager;
    await orders.goto(`?q=${order.order_number}`);
    await orders.grid.rows.first().getByRole("link", { name: order.order_number }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/orders/${order.id}$`));
  });

  test("Space toggles a checkbox filter, and focus stays on it", async ({ manager }) => {
    const { page, app } = manager;
    await app.inventory.goto();
    const checkbox = page.getByLabel("Low stock only");
    await checkbox.focus();
    await whileWaitingFor(page, { method: "GET", path: "/inventory", params: { low_stock: "true" } }, () => page.keyboard.press("Space"));
    await expect(checkbox).toBeChecked();
    await expect(checkbox).toBeFocused();
  });

  test("pagination by keyboard keeps focus, including when the button disables itself", async ({ manager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 20 } });
    for (let index = 0; index < 16; index++) await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { page, app } = manager;
    await app.orders.goto(`?customer_id=${customer.id}`);
    await expect(app.orders.grid.summary).toContainText("page 1 of 2");
    await page.getByRole("button", { name: "Next", exact: true }).focus();
    await whileWaitingFor(page, { method: "GET", path: "/orders", params: { page: "2" } }, () => page.keyboard.press("Enter"));
    await expect(app.orders.grid.summary).toContainText("page 2 of 2");
    await expectFocusNotLost(page, "focus after reaching the last page");
  });
});

test.describe("keyboard: dropdowns and filters", { tag: "@keyboard" }, () => {
  test("a dropdown filter can be set and applied from the keyboard", async ({ manager }) => {
    const { orders } = manager.app;
    const { page } = manager;
    await orders.goto();
    await orders.status.focus();
    await page.keyboard.type("Cancelled");
    await expect(orders.status).toHaveValue("CANCELLED");
    await whileWaitingFor(page, { method: "GET", path: "/orders", params: { status: "CANCELLED" } }, () => orders.q.press("Enter"));
    await expect(page).toHaveURL(/status=CANCELLED/);
    await expectFocusNotLost(page, "focus after applying filters");
  });

  test("a filter that applies on change keeps focus on the control", async ({ manager }) => {
    const { products } = manager.app;
    const { page } = manager;
    await products.goto();
    const availability = page.getByLabel("Availability");
    await availability.focus();
    await whileWaitingFor(page, { method: "GET", path: "/products", params: { in_stock: "true" } }, () => page.keyboard.type("In stock"));
    await expect(availability).toHaveValue("true");
    await expect(availability).toBeFocused();
  });

  test("a search with no results leaves focus on the search box", async ({ manager }) => {
    const { products } = manager.app;
    const { page } = manager;
    await products.goto();
    const search = page.getByLabel("Search name or SKU");
    await search.fill("no-such-product-anywhere");
    await whileWaitingFor(page, { method: "GET", path: "/products", params: { q: "no-such-product-anywhere" } }, () => search.press("Enter"));
    await expect(products.emptyState).toBeVisible();
    await expect(search).toBeFocused();
  });
});

test.describe("keyboard: dialogs", { tag: "@keyboard" }, () => {
  test("Escape closes a dialog and returns focus to what opened it", async ({ manager }) => {
    const { products } = manager.app;
    const { page } = manager;
    await products.goto();
    await products.newProductButton.focus();
    await page.keyboard.press("Enter");
    await products.newProductModal.expectOpenWithFocusInside();
    await products.newProductModal.closeWithEscape();
    await expect(products.newProductButton).toBeFocused();
  });

  test("the close and cancel buttons work from the keyboard and return focus", async ({ manager }) => {
    const { products } = manager.app;
    const { page } = manager;
    await products.goto();
    for (const name of ["Close", "Cancel"]) {
      await products.newProductButton.focus();
      await page.keyboard.press("Enter");
      await products.newProductModal.expectOpenWithFocusInside();
      await products.newProductModal.pressButton(name);
      await products.newProductModal.expectClosed();
      await expect(products.newProductButton).toBeFocused();
    }
  });

  test("Tab and Shift+Tab stay inside the dialog", async ({ manager, browserName }) => {
    const { products } = manager.app;
    const { page } = manager;
    await products.goto();
    await products.newProductButton.click();
    await products.newProductModal.expectOpenWithFocusInside();
    for (const reverse of [false, false, false, false, false, false, false, false, true, true, true]) {
      await tab(page, browserName, reverse);
      const stop = await focusStop(page);
      // Between the last control and the first, focus may rest on the browser's own UI. It never reaches the page.
      const insideOrBrowser = await page.evaluate(() => {
        const active = document.activeElement;
        return !active || active === document.body || Boolean(active.closest("dialog"));
      });
      expect(insideOrBrowser, `focus at ${stop?.description ?? "browser UI"}`).toBe(true);
    }
  });

  test("a dialog opens with focus on its first field", async ({ manager }) => {
    const { products } = manager.app;
    const { page } = manager;
    await products.goto();
    await products.newProductButton.focus();
    await page.keyboard.press("Space");
    await expect(products.newProductModal.field("SKU")).toBeFocused();
  });

  test("Enter in a dialog field submits it, and a success returns focus to the opener", async ({ manager, data }) => {
    const product = await data.product({ stock: { YYZ1: 5 } });
    const { inventory } = manager.app;
    const { page } = manager;
    await inventory.goto();
    await inventory.search(product.sku);
    const opener = inventory.adjustButton(product.sku, "YYZ1");
    await opener.focus();
    await page.keyboard.press("Enter");
    await inventory.newQuantity.fill("9");
    await inventory.reason.fill("keyboard save");
    await whileWaitingFor(page, { method: "PATCH", path: /^\/inventory\/[^/]+$/ }, () => inventory.reason.press("Enter"));
    await inventory.adjustModal.expectClosed();
    await expect(opener).toBeFocused();
  });

  test("when the dialog's opener no longer exists, focus is not lost", async ({ manager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { orderDetails } = manager.app;
    const { page } = manager;
    await orderDetails.goto(order.id);
    await page.getByTestId("order-actions").getByRole("button", { name: "Cancel order" }).focus();
    await page.keyboard.press("Enter");
    await orderDetails.statusModal.expectOpenWithFocusInside();
    await whileWaitingFor(page, { method: "PATCH", path: /^\/orders\/[^/]+\/status$/ }, () => orderDetails.statusModal.pressButton("Cancel order"));
    await expect(orderDetails.status).toHaveText("Cancelled");
    await expectFocusNotLost(page, "focus after the action button disappeared");
  });
});

test.describe("keyboard: focus after actions", { tag: "@keyboard" }, () => {
  test("a server error in a dialog keeps focus in the dialog", async ({ manager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { orderDetails } = manager.app;
    const { page } = manager;
    await orderDetails.goto(order.id);
    await page.getByTestId("order-actions").getByRole("button", { name: "Confirm order" }).focus();
    await page.keyboard.press("Enter");
    await orderDetails.statusModal.expectOpenWithFocusInside();
    await whileWaitingFor(page, { method: "PATCH", path: /^\/orders\/[^/]+\/status$/ }, () => orderDetails.statusModal.pressButton("Confirm order"));
    await expect(orderDetails.statusError).toBeVisible();
    await orderDetails.statusModal.expectOpenWithFocusInside();
  });

  test("a declined payment leaves focus on the button, ready to try again", async ({ manager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { orderDetails } = manager.app;
    const { page } = manager;
    await orderDetails.goto(order.id);
    await orderDetails.selectPaymentOutcome("Simulated: declined");
    const run = page.getByRole("button", { name: "Run payment" });
    await run.focus();
    await whileWaitingFor(page, { method: "POST", path: /^\/orders\/[^/]+\/payments$/ }, () => page.keyboard.press("Enter"));
    await expect(orderDetails.paymentRows).toHaveCount(1);
    await expect(run).toBeFocused();
  });

  test("running a payment by keyboard does not lose focus", async ({ manager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { orderDetails } = manager.app;
    const { page } = manager;
    await orderDetails.goto(order.id);
    await page.getByRole("button", { name: "Run payment" }).focus();
    await whileWaitingFor(page, { method: "POST", path: /^\/orders\/[^/]+\/payments$/ }, () => page.keyboard.press("Enter"));
    await expect(orderDetails.paymentRows).toHaveCount(1);
    await expectFocusNotLost(page, "focus after the payment");
  });

  test("removing an order line by keyboard moves focus to Add line", async ({ manager }) => {
    const { newOrder } = manager.app;
    const { page } = manager;
    await newOrder.goto();
    await newOrder.addLine();
    await page.getByRole("button", { name: "Remove line 2" }).focus();
    await page.keyboard.press("Enter");
    await expect(newOrder.product(2)).toBeHidden();
    await expect(page.getByRole("button", { name: "Add line" })).toBeFocused();
  });

  test("retiring a product by keyboard does not lose focus when its button disappears", async ({ admin, data }) => {
    const product = await data.product();
    const { productDetails } = admin.app;
    const { page } = admin;
    await productDetails.goto(product.id);
    await page.getByRole("button", { name: "Retire" }).focus();
    await page.keyboard.press("Enter");
    await productDetails.retireModal.expectOpenWithFocusInside();
    await whileWaitingFor(page, { method: "DELETE", path: /^\/products\/[^/]+$/ }, () => productDetails.retireModal.pressButton("Retire product"));
    await productDetails.retireModal.expectClosed();
    await expectFocusNotLost(page, "focus after retiring");
  });
});

test.describe("keyboard: focus after validation errors", { tag: "@keyboard" }, () => {
  test("a failed login moves focus to the first invalid field", async ({ anon }) => {
    const { login } = anon.app;
    const { page } = anon;
    await login.goto();
    await login.submitButton.focus();
    await page.keyboard.press("Enter");
    await expect(login.email).toHaveAttribute("aria-invalid", "true");
    await expect(login.email).toBeFocused();
    await login.email.fill("someone@e2e.example");
    await login.submitButton.focus();
    await page.keyboard.press("Enter");
    await expect(login.password).toBeFocused();
  });

  test("rejected credentials return focus to the cleared password", async ({ anon }) => {
    const { login } = anon.app;
    const { page } = anon;
    await login.goto();
    await login.email.fill("nobody@e2e.example");
    await login.password.fill("wrong-password");
    await whileWaitingFor(page, { method: "POST", path: "/auth/login" }, () => login.password.press("Enter"));
    await expect(login.error).toBeVisible();
    await expect(login.password).toBeFocused();
  });

  test("a failed new order moves focus to the first invalid field", async ({ manager }) => {
    const { newOrder } = manager.app;
    const { page } = manager;
    await newOrder.goto();
    await newOrder.submitButton.focus();
    await page.keyboard.press("Enter");
    await expect(newOrder.customer).toHaveAttribute("aria-invalid", "true");
    await expect(newOrder.customer).toBeFocused();
  });

  test("a failed dialog moves focus to the first invalid field, and stays in the dialog", async ({ manager, data }) => {
    const product = await data.product({ stock: { YYZ1: 5 } });
    const { inventory } = manager.app;
    const { page } = manager;
    await inventory.goto();
    await inventory.search(product.sku);
    await inventory.adjustButton(product.sku, "YYZ1").click();
    await inventory.newQuantity.fill("-1");
    await inventory.adjustModal.button("Save quantity").focus();
    await page.keyboard.press("Enter");
    await expect(inventory.newQuantity).toHaveAttribute("aria-invalid", "true");
    await expect(inventory.newQuantity).toBeFocused();
    await inventory.newQuantity.fill("3");
    await inventory.adjustModal.button("Save quantity").focus();
    await page.keyboard.press("Enter");
    await expect(inventory.reason).toBeFocused();
  });

  test("a failed product form moves focus to the first invalid field", async ({ manager }) => {
    const { products } = manager.app;
    const { page } = manager;
    await products.goto();
    await products.newProductButton.click();
    await products.newProductModal.button("Create product").focus();
    await page.keyboard.press("Enter");
    await expect(products.newProductModal.field("SKU")).toBeFocused();
  });
});
