import { createActors, get, loginCookie, placeOrder, seconds, send, uniqueKey } from "../lib.js";
import { loadThresholds } from "../thresholds.js";

const VUS = 30;

// About 70% reads and 30% writes, including row contention on one shared hot product.
export const options = {
  thresholds: loadThresholds("mixed"),
  setupTimeout: "180s",
  scenarios: {
    mixed: {
      executor: "ramping-vus",
      stages: [
        { duration: seconds(10), target: VUS },
        { duration: seconds(50), target: VUS },
        { duration: seconds(5), target: 0 },
      ],
    },
  },
};

export const setup = () => ({ actors: createActors(VUS, __ENV.PERF_RUN_ID) });

let cookie;

export default function ({ actors }) {
  const actor = actors[(__VU - 1) % actors.length];
  cookie ??= loginCookie(actor);
  const roll = __ITER % 10;
  if (roll < 3) get("/products?page_size=20", cookie, "GET /products");
  else if (roll < 5) get("/orders?page_size=15", cookie, "GET /orders");
  else if (roll < 6) get("/inventory?page_size=20", cookie, "GET /inventory");
  else if (roll < 7) get("/dashboard/summary", cookie, "GET /dashboard/summary");
  else {
    const hot = roll === 9 ? { ...actor, productId: actors[0].productId } : actor;
    const created = placeOrder(cookie, hot, roll === 9 ? "POST /orders hot row" : "POST /orders");
    if (created.status !== 201) return;
    const order = created.json();
    send("POST", `/orders/${order.id}/payments`, cookie, { method_token: "sim_success" }, "POST /payments", { "Idempotency-Key": uniqueKey() });
    send("PATCH", `/orders/${order.id}/status`, cookie, { status: "CANCELLED" }, "PATCH /orders/{id}/status");
  }
}
