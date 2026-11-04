import { expect, type Locator } from "@playwright/test";
import { whileWaitingFor } from "../helpers/network";
import { BasePage } from "./base-page";

export class DashboardPage extends BasePage {
  get totalOrders(): Locator {
    return this.page.getByTestId("stat-total-orders");
  }
  get openOrders(): Locator {
    return this.page.getByTestId("stat-open-orders");
  }
  get settledRevenue(): Locator {
    return this.page.getByTestId("stat-revenue");
  }
  get recentOrders(): Locator {
    return this.page.getByTestId("recent-orders").locator("tbody tr");
  }

  async goto(): Promise<void> {
    await whileWaitingFor(this.page, { method: "GET", path: "/dashboard/summary" }, async () => {
      await this.page.goto("/");
    });
    await expect(this.totalOrders).toBeVisible();
  }
}
