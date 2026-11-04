import type { Page } from "@playwright/test";
import { ToastComponent } from "../components/toast";

/** Only what every page genuinely shares. Page-specific behaviour stays on the page objects. */
export abstract class BasePage {
  readonly toasts: ToastComponent;

  constructor(readonly page: Page) {
    this.toasts = new ToastComponent(page);
  }
}
