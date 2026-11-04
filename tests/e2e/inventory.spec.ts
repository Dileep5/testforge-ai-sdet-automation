import type { ModalComponent } from "../../framework/components/modal";
import { expect, test } from "../../framework/fixtures";

test.describe("inventory", { tag: "@regression" }, () => {
  test("search finds only the matching product, one row per warehouse", { tag: "@smoke" }, async ({ viewer, data }) => {
    const product = await data.product({ stock: { YYZ1: 25, YYC1: 3 } });
    await data.product();
    const { inventory } = viewer.app;
    await inventory.goto();
    await inventory.search(product.sku);
    await expect(inventory.grid.summary).toHaveText("4 records · page 1 of 1");
    await expect(await inventory.grid.column("SKU")).toHaveText(Array<string>(4).fill(product.sku));
    await expect(inventory.grid.row("YYZ1").getByTestId("inventory-quantity")).toHaveText("25");
    await expect(inventory.grid.row("YYC1")).toContainText("Low");
    await expect(inventory.grid.row("YUL1")).toContainText("Out of stock");
  });

  test("a manager's adjustment is saved and audited with its reason", { tag: ["@smoke", "@critical"] }, async ({ manager, data, db }) => {
    const product = await data.product({ stock: { YYZ1: 25 } });
    const row = product.stock.find((item) => item.warehouse.code === "YYZ1");
    const { inventory } = manager.app;
    await inventory.goto();
    await inventory.search(product.sku);
    await inventory.adjustButton(product.sku, "YYZ1").click();
    await expect(inventory.newQuantity).toHaveValue("25");
    await inventory.newQuantity.fill("321");
    await inventory.reason.fill("annual count");
    await inventory.submitAdjustment();

    await inventory.toasts.expectSuccess(`${product.sku} at YYZ1 is now 321`);
    await inventory.adjustModal.expectClosed();
    await expect(inventory.grid.row("YYZ1").getByTestId("inventory-quantity")).toHaveText("321");
    expect(await db.stock(product.id, "YYZ1")).toBe(321);
    expect(await db.stock(product.id, "YYC1")).toBe(0);

    const [audit] = await db.audit(row?.inventory_id ?? "", "inventory.updated").then((rows) => rows.slice(-1));
    expect(audit?.actor_email).toBe("manager@testforge.example");
    expect(audit?.details).toEqual({ from: 25, to: 321, reason: "annual count" });
  });

  test("invalid quantities are refused, linked to the field, and clear once corrected", { tag: "@critical" }, async ({ manager, data, db }) => {
    const product = await data.product({ stock: { YYZ1: 25 } });
    const { inventory } = manager.app;
    await inventory.goto();
    await inventory.search(product.sku);
    await inventory.adjustButton(product.sku, "YYZ1").click();

    await inventory.newQuantity.fill("-5");
    await inventory.reason.fill("x");
    await inventory.adjustModal.button("Save quantity").click();

    const quantityError = inventory.adjustModal.root.getByText("Enter a whole number, zero or more");
    const reasonError = inventory.adjustModal.root.getByText("Enter a reason of at least 3 characters");
    await expect(quantityError).toBeVisible();
    await expect(reasonError).toBeVisible();
    await expect(inventory.newQuantity).toHaveAttribute("aria-invalid", "true");
    await expect(inventory.newQuantity).toHaveAccessibleDescription("Enter a whole number, zero or more");

    await inventory.newQuantity.fill("1.5");
    await expect(quantityError).toBeVisible();
    await inventory.newQuantity.fill("7");
    await expect(quantityError).toBeHidden();
    await expect(inventory.newQuantity).not.toHaveAttribute("aria-invalid", "true");
    await expect(reasonError).toBeVisible();
    await inventory.reason.fill("recount");
    await expect(reasonError).toBeHidden();

    expect(await db.stock(product.id, "YYZ1"), "nothing saved until the form is valid").toBe(25);
    await inventory.submitAdjustment();
    await inventory.adjustModal.expectClosed();
    expect(await db.stock(product.id, "YYZ1")).toBe(7);
  });

  test("a stale edit cannot overwrite someone else's newer change", { tag: "@critical" }, async ({ manager, data, setupApi, db }) => {
    const product = await data.product({ stock: { YYZ1: 25 } });
    const { inventory } = manager.app;
    await inventory.goto();
    await inventory.search(product.sku);
    await inventory.adjustButton(product.sku, "YYZ1").click();
    await inventory.newQuantity.fill("999");
    await inventory.reason.fill("my stale edit");

    // Someone else changes the row after this dialog has opened.
    const fresh = await setupApi.product(product.id);
    const row = fresh.stock.find((item) => item.warehouse.code === "YYZ1");
    await setupApi.adjustInventory(row?.inventory_id ?? "", 40, row?.version ?? 0, "someone else");

    await inventory.submitAdjustment();
    await expect(inventory.adjustError).toContainText("changed by someone else");
    expect(await db.stock(product.id, "YYZ1")).toBe(40);

    // The grid behind has refreshed, so a new attempt starts from the current value and succeeds.
    await inventory.adjustModal.button("Cancel").click();
    await expect(inventory.grid.row("YYZ1").getByTestId("inventory-quantity")).toHaveText("40");
    await inventory.adjustButton(product.sku, "YYZ1").click();
    await expect(inventory.newQuantity).toHaveValue("40");
    await inventory.newQuantity.fill("41");
    await inventory.reason.fill("recount after conflict");
    await inventory.submitAdjustment();
    await inventory.adjustModal.expectClosed();
    expect(await db.stock(product.id, "YYZ1")).toBe(41);
  });

  const closers: { name: string; close: (modal: ModalComponent) => Promise<void> }[] = [
    { name: "Escape key", close: (modal) => modal.closeWithEscape() },
    { name: "Cancel button", close: (modal) => modal.pressButton("Cancel") },
  ];
  for (const { name, close } of closers) {
    test(`closing the dialog with the ${name} returns keyboard focus to the opener`, { tag: "@critical" }, async ({ manager, data }) => {
      const product = await data.product({ stock: { YYZ1: 25 } });
      const { app, page } = manager;
      const { inventory } = app;
      await inventory.goto();
      await inventory.search(product.sku);

      const opener = inventory.adjustButton(product.sku, "YYZ1");
      await opener.focus();
      await page.keyboard.press("Enter");
      await inventory.adjustModal.expectOpenWithFocusInside();

      await close(inventory.adjustModal);
      await inventory.adjustModal.expectClosed();
      await expect(opener).toBeFocused();
    });
  }

  test("closing the order status dialog returns focus to its opener", { tag: "@critical" }, async ({ manager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { orderDetails } = manager.app;
    await orderDetails.goto(order.id);
    const opener = manager.page.getByTestId("order-actions").getByRole("button", { name: "Cancel order" });
    await opener.focus();
    await manager.page.keyboard.press("Enter");
    await orderDetails.statusModal.expectOpenWithFocusInside();
    await orderDetails.statusModal.closeWithEscape();
    await expect(opener).toBeFocused();
  });

  test("the low stock filter shows a low row and leaves out a healthy one", async ({ manager, data }) => {
    const low = await data.product({ stock: { YYZ1: 3, YYC1: 50 } });
    const { inventory } = manager.app;
    await inventory.goto();
    await inventory.search(low.sku);
    await expect(inventory.grid.rows).toHaveCount(4);
    await inventory.setLowStockOnly();
    await expect(inventory.grid.rows).toHaveCount(3);
    await expect(inventory.grid.row("YYC1")).toHaveCount(0);
    await expect(inventory.grid.row("YYZ1")).toContainText("Low");
  });
});
