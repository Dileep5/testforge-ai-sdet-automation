import { expect, type Locator, type Page } from "@playwright/test";

/** A dialog. Fields are scoped to it, because the page behind can have fields with the same labels. */
export class ModalComponent {
  readonly root: Locator;

  constructor(
    private readonly page: Page,
    testId: string,
  ) {
    this.root = page.getByTestId(testId);
  }

  field(label: string): Locator {
    return this.root.getByLabel(label, { exact: true });
  }

  button(name: string): Locator {
    return this.root.getByRole("button", { name, exact: true });
  }

  async expectOpenWithFocusInside(): Promise<void> {
    await expect(this.root).toBeVisible();
    await expect(this.root.locator(":focus")).toHaveCount(1);
  }

  async expectClosed(): Promise<void> {
    await expect(this.root).toBeHidden();
  }

  async closeWithEscape(): Promise<void> {
    await this.page.keyboard.press("Escape");
    await this.expectClosed();
  }

  /** Activate a button from the keyboard, as a keyboard user would. */
  async pressButton(name: string): Promise<void> {
    await this.button(name).focus();
    await this.page.keyboard.press("Enter");
  }
}
