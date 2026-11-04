import { sleep } from "k6";
import http from "k6/http";
import { API, createActors, get, placeOrder, record, seconds, send, uniqueKey } from "../lib.js";
import { overloadThresholds } from "../thresholds.js";

const ACTORS = 20;
const PEAK_VUS = Number(__ENV.PERF_PEAK_VUS || 300);
// A client that gives up after this long, as a browser or proxy eventually does.
const CLIENT_TIMEOUT = "5s";

// Requests already queued when the peak ends finish after it. A queued request waits at most
// MAX_QUEUE_WAIT_SECONDS (4), and the slowest work holds a slot for 1 second, so 5 seconds is enough.
// Not scaled by PERF_SCALE: draining takes the same real time however short the scenario is. Without
// this, the short run's "after" stage started with the queue still full, and measured the leftovers.
const DRAIN_SECONDS = 5;
const whole = (duration) => Number.parseInt(duration, 10);
const afterStart = `${whole(seconds(20)) + whole(seconds(PEAK_VUS / 10)) + whole(seconds(60)) + whole(seconds(5)) + DRAIN_SECONDS}s`;

// New connections arrive at no more than 10 per second, so the macOS listen queue of 128 is not what
// gets measured: existing connections hold requests open in the API's own queue.
export const options = {
  thresholds: overloadThresholds(),
  setupTimeout: "120s",
  scenarios: {
    before: { executor: "constant-vus", vus: 10, duration: seconds(20), exec: "traffic" },
    overload: {
      executor: "ramping-vus",
      startTime: seconds(20),
      exec: "traffic",
      startVUs: 0,
      stages: [
        { duration: seconds(PEAK_VUS / 10), target: PEAK_VUS },
        { duration: seconds(60), target: PEAK_VUS },
        { duration: seconds(5), target: 0 },
      ],
      gracefulRampDown: "0s",
      gracefulStop: "0s",
    },
    after: {
      executor: "constant-vus",
      vus: 10,
      startTime: afterStart,
      duration: seconds(40),
      exec: "traffic",
    },
  },
};

export const setup = () => ({ actors: createActors(ACTORS, __ENV.PERF_RUN_ID) });

let cookie;
let order;

/**
 * Clients back off when refused or left waiting, honouring Retry-After. Without this, a failed request
 * repeats in a tight loop, and the run measures the operating system's connection queue, not the API.
 */
function backOffIfFailed(response) {
  if (response.status === 0 || response.status >= 500) {
    const retryAfter = Number(response.headers["Retry-After"] || 1);
    sleep(retryAfter + Math.random());
  }
  return response;
}

function login({ email, password }) {
  const response = backOffIfFailed(
    record(
      http.post(`${API}/auth/login`, JSON.stringify({ email, password }), {
        headers: { "Content-Type": "application/json" },
        tags: { name: "POST /auth/login" },
        timeout: CLIENT_TIMEOUT,
      }),
    ),
  );
  return response.status === 200 ? `testforge_session=${response.cookies.testforge_session[0].value}` : undefined;
}

// 80% product lists; 20% simulated gateway timeouts, which hold an admission slot for a full second.
export function traffic({ actors }) {
  const actor = actors[(__VU - 1) % actors.length];
  cookie ??= login(actor);
  if (!cookie) return;
  if (!order) {
    const created = backOffIfFailed(placeOrder(cookie, actor, "POST /orders", CLIENT_TIMEOUT));
    if (created.status === 201) order = created.json();
    return;
  }
  if (__ITER % 5 === 0) {
    backOffIfFailed(send("POST", `/orders/${order.id}/payments`, cookie, { method_token: "sim_timeout" }, "POST /payments slow", { "Idempotency-Key": uniqueKey() }, CLIENT_TIMEOUT));
  } else {
    backOffIfFailed(get("/products?page_size=20", cookie, "GET /products", CLIENT_TIMEOUT));
  }
}
