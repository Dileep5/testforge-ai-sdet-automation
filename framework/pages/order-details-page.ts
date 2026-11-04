import { expect, type Locator } from "@playwright/test";
import { ModalComponent } from "../components/modal";
import { parseMoney, type Totals } from "../helpers/money";
import { whileWaitingFor } from "../helpers/network";
import type { Payment } from "../helpers/types";
import { BasePage } from "./base-page";

export const PAYMENT_LABELS = {
  sim_success: "Simulated: approved",
  sim_declined: "Simulated: declined",
  sim_timeout: "Simulated: gateway timeout",
} as const;

export class OrderDetailsPage extends BasePage {
  readonly statusModal = new ModalComponent(this.page, "status-modal");

  get orderNumber(): Locator {
    return this.page.getByTestId("order-number");
  }
  get status(): Locator {
    return this.page.getByTestId("order-status");
  }
  get actions(): Locator {
    return this.page.getByTestId("order-actions").getByRole("button");
  }
  get items(): Locator {
    return this.page.getByTestId("order-items").locator("tbody tr");
  }
  get paymentForm(): Locator {
    return this.page.getByTestId("payment-form");
  }
  get paymentRows(): Locator {
    return this.page.getByTestId("payment-row");
  }
  get history(): Locator {
    return this.page.getByTestId("order-history").getByRole("listitem");
  }
  get statusError(): Locator {
    return this.page.getByTestId("status-error");
  }
  get notFound(): Locator {
    return this.page.getByTestId("empty-state");
  }

  async goto(orderId: string): Promise<void> {
    await this.page.goto(`/orders/${orderId}`);
    await expect(this.orderNumber).toBeVisible();
  }

  async totals(): Promise<Totals> {
    return {
      subtotalCents: parseMoney(await this.page.getByTestId("order-subtotal").innerText()),
      taxCents: parseMoney(await this.page.getByTestId("order-tax").innerText()),
      totalCents: parseMoney(await this.page.getByTestId("order-total").innerText()),
    };
  }

  /** Open a status action's dialog and confirm it, returning the outcome for the caller to check. */
  async attemptTransition(action: string, note = ""): Promise<void> {
    await this.page.getByTestId("order-actions").getByRole("button", { name: action }).click();
    if (note) await this.statusModal.field("Note").fill(note);
    await whileWaitingFor(this.page, { method: "PATCH", path: /^\/orders\/[^/]+\/status$/ }, () =>
      this.statusModal.button(action).click(),
    );
  }

  async transition(action: string, expectedStatus: string, note = ""): Promise<void> {
    await this.attemptTransition(action, note);
    await expect(this.status).toHaveText(expectedStatus);
  }

  async selectPaymentOutcome(label: string): Promise<void> {
    await this.page.getByLabel("Simulated outcome").selectOption({ label });
  }

  async runPayment(label: string): Promise<{ payment: Payment; replayed: boolean }> {
    await this.selectPaymentOutcome(label);
    const response = await whileWaitingFor(this.page, { method: "POST", path: /^\/orders\/[^/]+\/payments$/ }, () =>
      this.page.getByRole("button", { name: "Run payment" }).click(),
    );
    return { payment: (await response.json()) as Payment, replayed: response.status() === 200 };
  }

  async settle(): Promise<Payment> {
    const response = await whileWaitingFor(this.page, { method: "POST", path: /^\/payments\/[^/]+\/settle$/ }, () =>
      this.page.getByRole("button", { name: "Settle" }).click(),
    );
    return (await response.json()) as Payment;
  }
}
