import { expect, type Locator } from "@playwright/test";
import { GridComponent } from "../components/grid";
import { whileWaitingFor } from "../helpers/network";
import { BasePage } from "./base-page";

export interface OrderFilters {
  q?: string;
  dateFrom?: string;
  dateTo?: string;
  warehouse?: string;
  customer?: string;
  status?: string;
}

export interface Download {
  filename: string;
  text: string;
}

export class OrdersPage extends BasePage {
  readonly grid = new GridComponent(this.page, "orders-grid", "order-row", "/orders");

  get q(): Locator {
    return this.page.getByLabel("Order number");
  }
  get dateFrom(): Locator {
    return this.page.getByLabel("From date");
  }
  get dateTo(): Locator {
    return this.page.getByLabel("To date");
  }
  get warehouse(): Locator {
    return this.page.getByLabel("Warehouse");
  }
  get customer(): Locator {
    return this.page.getByLabel("Customer");
  }
  get status(): Locator {
    return this.page.getByLabel("Status");
  }
  get emptyState(): Locator {
    return this.page.getByTestId("empty-state");
  }
  get newOrderLink(): Locator {
    return this.page.getByRole("link", { name: "New order" });
  }

  async goto(query = ""): Promise<void> {
    await whileWaitingFor(this.page, { method: "GET", path: "/orders" }, async () => {
      await this.page.goto(`/orders${query}`);
    });
  }

  /** Warehouses are labelled "CODE · City", so match by the code. */
  async selectWarehouse(code: string): Promise<void> {
    const option = this.warehouse.locator("option", { hasText: `${code} ·` });
    await expect(option).toBeAttached();
    await this.warehouse.selectOption((await option.getAttribute("value")) ?? "");
  }

  async fill(filters: OrderFilters): Promise<void> {
    if (filters.q !== undefined) await this.q.fill(filters.q);
    if (filters.dateFrom !== undefined) await this.dateFrom.fill(filters.dateFrom);
    if (filters.dateTo !== undefined) await this.dateTo.fill(filters.dateTo);
    if (filters.warehouse !== undefined) await this.selectWarehouse(filters.warehouse);
    if (filters.customer !== undefined) await this.customer.selectOption({ label: filters.customer });
    if (filters.status !== undefined) await this.status.selectOption(filters.status);
  }

  /** The API parameters the form's current contents should produce. */
  private async formParams(): Promise<Record<string, string>> {
    const fields: [string, Locator][] = [
      ["q", this.q],
      ["date_from", this.dateFrom],
      ["date_to", this.dateTo],
      ["warehouse_id", this.warehouse],
      ["customer_id", this.customer],
      ["status", this.status],
    ];
    const params: Record<string, string> = { page: "1", page_size: "15" };
    for (const [key, field] of fields) {
      const value = await field.inputValue();
      if (value) params[key] = value;
    }
    return params;
  }

  async submitFilters(): Promise<void> {
    const params = await this.formParams();
    const sort = new URL(this.page.url()).searchParams;
    params.sort = sort.get("sort") ?? "created_at";
    params.direction = sort.get("direction") ?? "desc";
    await whileWaitingFor(this.page, { method: "GET", path: "/orders", params, exactParams: true }, () =>
      this.page.getByRole("button", { name: "Apply filters" }).click(),
    );
  }

  async filter(filters: OrderFilters): Promise<void> {
    await this.fill(filters);
    await this.submitFilters();
  }

  async clearFilters(): Promise<void> {
    await this.page.getByRole("button", { name: "Clear" }).click();
  }

  /**
   * Click Clear and enter text within one browser task, which is the fastest any user could be. The
   * input is then guaranteed to land before Clear's URL update commits, whatever the machine's
   * speed. Real keystrokes cannot force that order, because a production build commits too quickly.
   */
  async clearAndTypeOrderNumberInSameTask(text: string): Promise<void> {
    await this.page.evaluate((value) => {
      const clear = [...document.querySelectorAll("button")].find((button) => button.textContent === "Clear");
      const input = [...document.querySelectorAll("label")].find((label) => label.textContent === "Order number")?.control;
      if (!clear || !(input instanceof HTMLInputElement)) throw new Error("Orders filter form not found");
      clear.click();
      // React tracks the input's value, so go through the prototype setter as real typing does.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, text);
  }

  async exportCsv(): Promise<Download> {
    const downloadStarted = this.page.waitForEvent("download");
    await this.page.getByRole("button", { name: "Export CSV" }).click();
    const download = await downloadStarted;
    const failure = await download.failure();
    if (failure) throw new Error(`Download failed: ${failure}`);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return { filename: download.suggestedFilename(), text: Buffer.concat(chunks).toString("utf8") };
  }

  async openOrder(orderNumber: string): Promise<void> {
    await this.page.getByRole("link", { name: orderNumber, exact: true }).click();
  }
}
