import { expect, type Locator, type Page } from "@playwright/test";

export class ToastComponent {
  private readonly region: Locator;

  constructor(page: Page) {
    this.region = page.getByTestId("toast-region");
  }

  async expectSuccess(text: string | RegExp): Promise<void> {
    await expect(this.region.getByTestId("toast-success").filter({ hasText: text })).toBeVisible();
  }

  async expectError(text: string | RegExp): Promise<void> {
    await expect(this.region.getByTestId("toast-error").filter({ hasText: text })).toBeVisible();
  }
}
