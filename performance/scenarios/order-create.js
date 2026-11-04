import { createActors, loginCookie, placeOrder, seconds, send } from "../lib.js";
import { loadThresholds } from "../thresholds.js";

const VUS = 10;

// Each virtual user has its own login, customer and product, so no two contend for a row lock.
export const options = {
  thresholds: loadThresholds("order-create"),
  setupTimeout: "120s",
  scenarios: { order_create: { executor: "constant-vus", vus: VUS, duration: seconds(40) } },
};

export const setup = () => ({ actors: createActors(VUS, __ENV.PERF_RUN_ID) });

let cookie;

export default function ({ actors }) {
  const actor = actors[(__VU - 1) % actors.length];
  cookie ??= loginCookie(actor);
  const created = placeOrder(cookie, actor);
  // Cancelling returns the stock, and adds a realistic second write.
  if (created.status === 201) {
    send("PATCH", `/orders/${created.json().id}/status`, cookie, { status: "CANCELLED" }, "PATCH /orders/{id}/status");
  }
}
