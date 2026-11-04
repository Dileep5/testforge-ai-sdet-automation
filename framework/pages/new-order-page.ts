import { expect, type Locator, type Response } from "@playwright/test";
import { parseMoney, type Totals } from "../helpers/money";
import { whileWaitingFor } from "../helpers/network";
import { BasePage } from "./base-page";

export class NewOrderPage extends BasePage {
  get customer(): Locator {
    return this.page.getByLabel("Customer");
  }
  get warehouse(): Locator {
    return this.page.getByLabel("Warehouse");
  }
  get submitButton(): Locator {
    return this.page.getByRole("button", { name: "Create order" });
  }
  get error(): Locator {
    return this.page.getByTestId("order-error");
  }

  async goto(): Promise<void> {
    await this.page.goto("/orders/new");
    await expect(this.submitButton).toBeVisible();
  }

  product(line: number): Locator {
    return this.page.getByLabel(`Product for line ${line}`);
  }

  quantity(line: number): Locator {
    return this.page.getByLabel(`Quantity for line ${line}`);
  }

  async selectCustomer(name: string): Promise<void> {
    await this.customer.selectOption({ label: name });
  }

  /** Choosing a warehouse loads its stock; the product lists depend on that response. */
  async selectWarehouse(code: string): Promise<void> {
    const option = this.warehouse.locator("option", { hasText: `${code} ·` });
    await expect(option).toBeAttached();
    const value = (await option.getAttribute("value")) ?? "";
    await whileWaitingFor(this.page, { method: "GET", path: "/inventory", params: { warehouse_id: value } }, () =>
      this.warehouse.selectOption(value).then(() => undefined),
    );
  }

  async setLine(line: number, sku: string, quantity: number): Promise<void> {
    const option = this.product(line).locator("option", { hasText: sku });
    await expect(option).toBeAttached();
    await this.product(line).selectOption((await option.getAttribute("value")) ?? "");
    await this.quantity(line).fill(String(quantity));
  }

  async addLine(): Promise<void> {
    await this.page.getByRole("button", { name: "Add line" }).click();
  }

  async previewTotals(): Promise<Totals> {
    return {
      subtotalCents: parseMoney(await this.page.getByTestId("preview-subtotal").innerText()),
      taxCents: parseMoney(await this.page.getByTestId("preview-tax").innerText()),
      totalCents: parseMoney(await this.page.getByTestId("preview-total").innerText()),
    };
  }

  async submit(): Promise<Response> {
    return whileWaitingFor(this.page, { method: "POST", path: "/orders" }, () => this.submitButton.click());
  }
}
