import { expect, type Locator } from "@playwright/test";
import { GridComponent } from "../components/grid";
import { ModalComponent } from "../components/modal";
import { whileWaitingFor } from "../helpers/network";
import { BasePage } from "./base-page";

export class InventoryPage extends BasePage {
  readonly grid = new GridComponent(this.page, "inventory-grid", "inventory-row", "/inventory");
  readonly adjustModal = new ModalComponent(this.page, "adjust-inventory-modal");

  get adjustButtons(): Locator {
    return this.page.getByRole("button", { name: /^Adjust / });
  }
  get adjustError(): Locator {
    return this.page.getByTestId("adjust-error");
  }
  get newQuantity(): Locator {
    return this.adjustModal.field("New quantity");
  }
  get reason(): Locator {
    return this.adjustModal.field("Reason");
  }

  adjustButton(sku: string, warehouseCode: string): Locator {
    return this.page.getByRole("button", { name: `Adjust ${sku} at ${warehouseCode}` });
  }

  async goto(): Promise<void> {
    await whileWaitingFor(this.page, { method: "GET", path: "/inventory" }, async () => {
      await this.page.goto("/inventory");
    });
  }

  async search(text: string): Promise<void> {
    const box = this.page.getByLabel("Search name or SKU");
    await box.fill(text);
    // WebKit lost the typed text once under load. If it recurs, this fails where it happens. No retry.
    await expect(box).toHaveValue(text);
    await whileWaitingFor(this.page, { method: "GET", path: "/inventory", params: { q: text } }, () =>
      this.page.getByRole("button", { name: "Search", exact: true }).click(),
    );
  }

  async setLowStockOnly(): Promise<void> {
    await whileWaitingFor(this.page, { method: "GET", path: "/inventory", params: { low_stock: "true" } }, () =>
      this.page.getByLabel("Low stock only").check(),
    );
  }

  async submitAdjustment(): Promise<void> {
    await whileWaitingFor(this.page, { method: "PATCH", path: /^\/inventory\/[^/]+$/ }, () =>
      this.adjustModal.button("Save quantity").click(),
    );
  }
}
