import { expect, type Locator, type Page } from "@playwright/test";
import { whileWaitingFor } from "../helpers/network";

export class NavigationComponent {
  readonly links: Locator;
  readonly currentUser: Locator;
  readonly currentRole: Locator;

  constructor(private readonly page: Page) {
    const nav = page.getByTestId("main-nav");
    this.links = nav.getByRole("link");
    this.currentUser = page.getByTestId("current-user");
    this.currentRole = page.getByTestId("current-role");
  }

  async expectLinks(names: string[]): Promise<void> {
    await expect(this.links).toHaveText(names);
  }

  async goTo(name: string): Promise<void> {
    await this.page.getByTestId("main-nav").getByRole("link", { name, exact: true }).click();
  }

  async signOut(): Promise<void> {
    await whileWaitingFor(this.page, { method: "POST", path: "/auth/logout" }, () =>
      this.page.getByRole("button", { name: "Sign out" }).click(),
    );
    await expect(this.page).toHaveURL(/\/login$/);
  }
}
