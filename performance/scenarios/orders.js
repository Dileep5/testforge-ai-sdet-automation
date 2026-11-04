import { SEED, get, loginCookie, seconds } from "../lib.js";
import { loadThresholds } from "../thresholds.js";

export const options = {
  thresholds: loadThresholds("orders"),
  scenarios: {
    orders: {
      executor: "ramping-vus",
      stages: [
        { duration: seconds(5), target: 20 },
        { duration: seconds(30), target: 20 },
        { duration: seconds(5), target: 0 },
      ],
    },
  },
};

export function setup() {
  const cookie = loginCookie(SEED.manager);
  const ids = get("/orders?page_size=60", cookie, "setup").json().items.map((order) => order.id);
  return { cookie, ids };
}

const FILTERS = [
  ["/orders?page_size=15", "GET /orders"],
  ["/orders?status=DELIVERED&page_size=15", "GET /orders by status"],
  ["/orders?date_from=2026-01-01&date_to=2026-03-31&sort=total_cents", "GET /orders by date"],
  ["/orders?q=ORD-1000", "GET /orders by number"],
];

export default function ({ cookie, ids }) {
  if (__ITER % 2 === 0) {
    const [path, name] = FILTERS[(__ITER / 2) % FILTERS.length];
    get(path, cookie, name);
  } else {
    get(`/orders/${ids[__ITER % ids.length]}`, cookie, "GET /orders/{id}");
  }
}
