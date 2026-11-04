import { expect, test } from "../../framework/fixtures";
import { expectApiError } from "../../framework/helpers/api-client";
import { PAYMENT_LABELS } from "../../framework/pages/order-details-page";
import type { Payment } from "../../framework/helpers/types";

/** Runs in the page. Makes key generation fail until the flag is cleared, as a broken browser API might. */
function breakKeyGeneration(): void {
  const original = crypto.getRandomValues.bind(crypto);
  Object.assign(window, { __breakKeys: true });
  Crypto.prototype.getRandomValues = function <T extends ArrayBufferView | null>(array: T): T {
    if ((window as unknown as { __breakKeys: boolean }).__breakKeys) throw new Error("Key generation is unavailable");
    return original(array as never);
  };
}

test.describe("simulated payments", { tag: "@regression" }, () => {
  test("approval, settlement and shipping follow the rules through to delivery", { tag: ["@smoke", "@critical"] }, async ({ manager, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ priceCents: 2500, stock: { YYZ1: 10 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 2 }] });
    const { orderDetails } = manager.app;
    await orderDetails.goto(order.id);

    const { payment } = await orderDetails.runPayment(PAYMENT_LABELS.sim_success);
    expect(payment.status).toBe("AUTHORIZED");
    // The server charges its own total. 2 x 25.00 + 13% = 56.50.
    expect(payment.amount_cents).toBe(5650);
    await expect(orderDetails.paymentRows).toContainText(["Authorized"]);
    await expect(orderDetails.paymentForm).toHaveCount(0);

    await orderDetails.transition("Confirm order", "Confirmed");

    // Shipping before settlement must be refused.
    await orderDetails.attemptTransition("Mark shipped");
    await expect(orderDetails.statusError).toContainText("settled before shipping");
    await orderDetails.statusModal.button("Keep as is").click();
    expect((await db.order(order.order_number)).status).toBe("CONFIRMED");
    expect((await db.payments(order.id))[0]?.settled_at).toBeNull();

    const settled = await orderDetails.settle();
    expect(settled.status).toBe("SETTLED");
    await expect(orderDetails.paymentRows).toContainText(["Settled"]);
    await orderDetails.transition("Mark shipped", "Shipped");
    await orderDetails.transition("Mark delivered", "Delivered");

    const [row] = await db.payments(order.id);
    expect(row).toMatchObject({ status: "SETTLED", amount_cents: 5650, failure_reason: null });
    expect(row?.authorized_at).not.toBeNull();
    expect(row?.settled_at).not.toBeNull();
    expect((await db.order(order.order_number)).status).toBe("DELIVERED");
    expect(await db.audit(payment.id, "payment.settled")).toHaveLength(1);
  });

  test("a payment works on plain HTTP, where browsers provide no crypto.randomUUID", async ({ manager, data }) => {
    // Browsers only offer it on HTTPS and localhost. Docker's http://web:8080 found this for real.
    await manager.page.addInitScript(() => Object.defineProperty(Crypto.prototype, "randomUUID", { value: undefined }));
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { orderDetails } = manager.app;
    await orderDetails.goto(order.id);
    await orderDetails.runPayment(PAYMENT_LABELS.sim_success);
    await expect(orderDetails.paymentRows).toHaveCount(1);
  });

  test("if a payment cannot be started, nothing is sent, the form recovers, and a retry works", async ({ manager, data }) => {
    await manager.page.addInitScript(breakKeyGeneration);
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { orderDetails } = manager.app;
    const { page } = manager;
    const payments: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") payments.push(request.url());
    });
    await orderDetails.goto(order.id);

    const button = orderDetails.paymentForm.getByRole("button");
    await button.click();
    await expect(orderDetails.paymentForm.getByRole("alert")).toContainText("could not be started");
    await expect(button).toHaveText("Run payment");
    await expect(button).toHaveAttribute("aria-disabled", "false");
    expect(payments).toEqual([]);

    await page.evaluate(() => Object.assign(window, { __breakKeys: false }));
    await orderDetails.runPayment(PAYMENT_LABELS.sim_success);
    await expect(orderDetails.paymentRows).toHaveCount(1);
    await expect(orderDetails.paymentForm.getByRole("alert")).toBeHidden();
  });

  test("a server failure during payment shows its message and restores the form", async ({ manager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 5 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { orderDetails } = manager.app;
    const { page } = manager;
    await page.route("**/api/v1/orders/*/payments", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred", details: [], request_id: "r" } } })
        : route.continue(),
    );
    await orderDetails.goto(order.id);

    const button = orderDetails.paymentForm.getByRole("button");
    await button.click();
    await expect(orderDetails.paymentForm.getByRole("alert")).toContainText("An unexpected error occurred");
    await expect(button).toHaveText("Run payment");
    await expect(button).toHaveAttribute("aria-disabled", "false");
    await expect(orderDetails.paymentRows).toHaveCount(0);
  });

  test("a declined payment is recorded and blocks confirmation, and a retry can succeed", { tag: "@critical" }, async ({ manager, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 10 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { orderDetails } = manager.app;
    await orderDetails.goto(order.id);

    const { payment } = await orderDetails.runPayment(PAYMENT_LABELS.sim_declined);
    expect(payment.status).toBe("DECLINED");
    await orderDetails.toasts.expectError("Payment was declined");
    await expect(orderDetails.paymentRows).toContainText(["Declined"]);
    await expect(orderDetails.paymentRows.first()).toContainText("Simulated issuer decline");

    await orderDetails.attemptTransition("Confirm order");
    await expect(orderDetails.statusError).toContainText("authorized payment is required");
    await orderDetails.statusModal.button("Keep as is").click();

    await orderDetails.runPayment(PAYMENT_LABELS.sim_success);
    await expect(orderDetails.paymentRows).toHaveCount(2);
    expect((await db.payments(order.id)).map((row) => row.status)).toEqual(["DECLINED", "AUTHORIZED"]);
  });

  test("a gateway timeout is recorded, captures nothing, and can be retried", { tag: "@critical" }, async ({ manager, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 10 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { orderDetails } = manager.app;
    await orderDetails.goto(order.id);

    const { payment } = await orderDetails.runPayment(PAYMENT_LABELS.sim_timeout);
    expect(payment.status).toBe("TIMED_OUT");
    await orderDetails.toasts.expectError("gateway timed out");
    await expect(orderDetails.paymentRows).toContainText(["Timed out"]);

    const [stored] = await db.payments(order.id);
    expect(stored).toMatchObject({ status: "TIMED_OUT", failure_reason: "SIMULATED_GATEWAY_TIMEOUT", authorized_at: null, settled_at: null });

    const retry = await orderDetails.runPayment(PAYMENT_LABELS.sim_success);
    expect(retry.payment.status).toBe("AUTHORIZED");
    await expect(orderDetails.paymentRows).toHaveCount(2);
  });

  test("retrying after a lost response replays the payment instead of creating a second", { tag: "@critical" }, async ({ manager, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 10 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { orderDetails } = manager.app;
    const { page } = manager;
    await orderDetails.goto(order.id);

    // The server really processes the request; only the response is lost on the way back.
    const paymentsUrl = `**/api/v1/orders/${order.id}/payments`;
    let keyUsed = "";
    await page.route(paymentsUrl, async (route) => {
      keyUsed = (await route.request().headerValue("idempotency-key")) ?? "";
      await route.fetch();
      await route.abort("connectionfailed");
    });
    await orderDetails.selectPaymentOutcome(PAYMENT_LABELS.sim_success);
    await page.getByRole("button", { name: "Run payment" }).click();
    await expect(orderDetails.paymentForm.getByRole("alert")).toContainText("could not be reached");
    await expect.poll(() => db.payments(order.id)).toHaveLength(1);
    await page.unroute(paymentsUrl);

    const retried = page.waitForResponse((response) => response.url().endsWith(`/orders/${order.id}/payments`) && response.request().method() === "POST");
    await page.getByRole("button", { name: "Run payment" }).click();
    const response = await retried;

    expect(response.status(), "a replay is 200, a new payment would be 201").toBe(200);
    expect(response.headers()["idempotency-replayed"]).toBe("true");
    expect(await response.request().headerValue("idempotency-key")).toBe(keyUsed);
    expect(keyUsed).not.toBe("");
    await expect(orderDetails.paymentRows).toHaveCount(1);
    expect((await db.payments(order.id)).map((row) => row.status)).toEqual(["AUTHORIZED"]);
    expect(await db.audit((await db.payments(order.id))[0]?.id ?? "", "payment.authorized")).toHaveLength(1);
  });

  test("an idempotency key cannot be reused for a different request", async ({ manager, data, db }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 10 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const other = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const { api } = manager;
    const key = `dup-${data.namespace}`;
    const body = { data: { method_token: "sim_success" }, headers: { "Idempotency-Key": key } };

    const first = await api.send("POST", `/orders/${order.id}/payments`, body);
    const replay = await api.send("POST", `/orders/${order.id}/payments`, body);
    expect([first.status(), replay.status()]).toEqual([201, 200]);
    expect(((await replay.json()) as Payment).id).toBe(((await first.json()) as Payment).id);

    await expectApiError(await api.send("POST", `/orders/${other.id}/payments`, body), 409, "IDEMPOTENCY_KEY_REUSED");
    expect(await db.payments(order.id)).toHaveLength(1);
    expect(await db.payments(other.id)).toHaveLength(0);
  });

  test("settling a payment twice is refused", async ({ manager, data }) => {
    const customer = await data.customer();
    const product = await data.product({ stock: { YYZ1: 10 } });
    const order = await data.order({ customer, lines: [{ product, quantity: 1 }] });
    const payment = await data.pay(order);
    await manager.api.settle(payment.id);
    await expectApiError(await manager.api.send("POST", `/payments/${payment.id}/settle`), 409, "INVALID_PAYMENT_STATE");
  });
});
