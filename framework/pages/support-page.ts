import { expect, type Locator } from "@playwright/test";
import { whileWaitingFor } from "../helpers/network";
import { BasePage } from "./base-page";

export class SupportPage extends BasePage {
  get question(): Locator {
    return this.page.getByTestId("support-question");
  }
  get submit(): Locator {
    return this.page.getByTestId("support-submit");
  }
  get answer(): Locator {
    return this.page.getByTestId("support-answer");
  }
  get sources(): Locator {
    return this.page.getByTestId("support-sources").getByRole("listitem");
  }
  get refusal(): Locator {
    return this.page.getByTestId("support-refusal");
  }

  async goto(): Promise<void> {
    await this.page.goto("/support");
    await expect(this.page.getByRole("heading", { level: 1, name: "Support" })).toBeVisible();
  }

  async ask(question: string): Promise<void> {
    await this.question.fill(question);
    await whileWaitingFor(this.page, { method: "POST", path: "/support/chat" }, () => this.submit.click());
  }
}
