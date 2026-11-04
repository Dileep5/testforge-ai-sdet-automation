import { expect, type Locator } from "@playwright/test";
import { ModalComponent } from "../components/modal";
import { whileWaitingFor } from "../helpers/network";
import { BasePage } from "./base-page";

export class UsersPage extends BasePage {
  readonly newUserModal = new ModalComponent(this.page, "new-user-modal");

  get table(): Locator {
    return this.page.getByTestId("users-grid");
  }
  get forbidden(): Locator {
    return this.page.getByTestId("forbidden");
  }

  row(email: string): Locator {
    return this.page.getByTestId("user-row").filter({ hasText: email });
  }

  async goto(): Promise<void> {
    await this.page.goto("/admin/users");
  }

  async changeRole(email: string, role: string): Promise<void> {
    await whileWaitingFor(this.page, { method: "PATCH", path: /^\/users\/[^/]+$/ }, () =>
      this.row(email).getByRole("combobox").selectOption(role).then(() => undefined),
    );
  }

  async deactivate(email: string): Promise<void> {
    await whileWaitingFor(this.page, { method: "PATCH", path: /^\/users\/[^/]+$/ }, () =>
      this.row(email).getByRole("button", { name: "Deactivate" }).click(),
    );
  }

  async createUser(fields: { email: string; name: string; password: string; role: string }): Promise<void> {
    await this.page.getByRole("button", { name: "New user" }).click();
    await this.newUserModal.field("Email").fill(fields.email);
    await this.newUserModal.field("Full name").fill(fields.name);
    await this.newUserModal.field("Password").fill(fields.password);
    await this.newUserModal.field("Role").selectOption(fields.role);
    await whileWaitingFor(this.page, { method: "POST", path: "/users" }, () =>
      this.newUserModal.button("Create user").click(),
    );
    await this.newUserModal.expectClosed();
  }
}

export class AuditLogPage extends BasePage {
  get table(): Locator {
    return this.page.getByTestId("audit-grid");
  }

  async goto(): Promise<void> {
    await this.page.goto("/admin/audit");
    await expect(this.table).toBeVisible();
  }
}
