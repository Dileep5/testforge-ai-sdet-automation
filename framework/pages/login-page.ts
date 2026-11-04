import { expect, type Locator, type Response } from "@playwright/test";
import { whileWaitingFor } from "../helpers/network";
import type { Credentials } from "../helpers/types";
import { BasePage } from "./base-page";

export class LoginPage extends BasePage {
  get email(): Locator {
    return this.page.getByLabel("Email");
  }
  get password(): Locator {
    return this.page.getByLabel("Password");
  }
  get submitButton(): Locator {
    return this.page.getByRole("button", { name: "Sign in" });
  }
  get error(): Locator {
    return this.page.getByTestId("login-error");
  }
  get sessionEnded(): Locator {
    return this.page.getByTestId("session-expired");
  }

  async goto(): Promise<void> {
    await this.page.goto("/login");
    await expect(this.submitButton).toBeVisible();
  }

  /** Sign in from the form that is already showing. */
  async signIn({ email, password }: Credentials): Promise<Response> {
    await this.email.fill(email);
    await this.password.fill(password);
    return whileWaitingFor(this.page, { method: "POST", path: "/auth/login" }, () => this.submitButton.click());
  }
}
