// Shared helpers for the k6 scenarios. Runs inside k6, not Node.
import http from "k6/http";
import { fail } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

export const BASE = __ENV.PERF_BASE_URL;
export const API = `${BASE}/api/v1`;
// PERF_SCALE shortens every duration, for checking a script works. Recorded results use 1.
const SCALE = Number(__ENV.PERF_SCALE || 1);
export const seconds = (value) => `${Math.max(1, Math.round(value * SCALE))}s`;

export const SEED = {
  admin: { email: "admin@testforge.example", password: "Admin!Forge2026" },
  manager: { email: "manager@testforge.example", password: "Manager!Forge2026" },
  viewer: { email: "viewer@testforge.example", password: "Viewer!Forge2026" },
};

const JSON_HEADERS = { "Content-Type": "application/json" };

// Only a server failure or no response counts as failed. Each status family has its own gate.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 499 }));

const status4xx = new Rate("status_4xx");
const status5xx = new Rate("status_5xx");
const refused503 = new Rate("refused_503");
const other5xx = new Counter("other_5xx");
const noResponse = new Counter("client_no_response");
const refusedDuration = new Trend("refused_duration", true);

/** Count one response for the thresholds. Returns it, so calls can be wrapped. */
export function record(response) {
  const { status } = response;
  status4xx.add(status >= 400 && status < 500);
  status5xx.add(status >= 500);
  refused503.add(status === 503);
  if (status === 0) noResponse.add(1);
  if (status > 503 || (status >= 500 && status < 503)) other5xx.add(1);
  if (status === 503) refusedDuration.add(response.timings.duration);
  return response;
}

/** Log in once and return the cookie, for sharing a session between iterations. */
export function loginCookie({ email, password }) {
  const response = record(
    http.post(`${API}/auth/login`, JSON.stringify({ email, password }), {
      headers: JSON_HEADERS,
      tags: { name: "POST /auth/login" },
    }),
  );
  if (response.status !== 200) fail(`login failed: ${response.status}`);
  return `testforge_session=${response.cookies.testforge_session[0].value}`;
}

export function get(path, cookie, name, timeout = "30s") {
  return record(http.get(`${API}${path}`, { headers: { Cookie: cookie }, tags: { name }, timeout }));
}

export function send(method, path, cookie, body, name, extraHeaders = {}, timeout = "30s") {
  return record(
    http.request(method, `${API}${path}`, JSON.stringify(body), {
      headers: { ...JSON_HEADERS, Cookie: cookie, ...extraHeaders },
      tags: { name },
      timeout,
    }),
  );
}

function created(response, label) {
  if (response.status !== 201) fail(`${label} failed: ${response.status} ${response.body}`);
  return response.json();
}

/** Synthetic users that own their data, so scenarios measure load rather than shared-row conflicts. */
export function createActors(count, runId) {
  const admin = loginCookie(SEED.admin);
  const warehouses = get("/warehouses", admin, "setup").json();
  const warehouse = warehouses.find((item) => item.code === "YYZ1");
  const actors = [];
  for (let index = 0; index < count; index++) {
    const tag = `${runId}-${index}`;
    const customer = created(
      send("POST", "/customers", admin, { code: `PERF-${tag}`, name: `Perf ${tag}`, contact_email: `perf-${tag}@perf.example` }, "setup"),
      "customer",
    );
    const password = "Perf-Synthetic-Passw0rd";
    const email = `perf-${tag}@perf.example`.toLowerCase();
    created(send("POST", "/users", admin, { email, full_name: `Perf ${tag}`, password, role: "MANAGER" }, "setup"), "user");
    const product = created(
      send("POST", "/products", admin, { sku: `PERF-${tag}`, name: `Perf ${tag}`, category: "Perf", unit_price_cents: 1999 }, "setup"),
      "product",
    );
    const row = product.stock.find((item) => item.warehouse.code === "YYZ1");
    const stocked = send(
      "PATCH",
      `/inventory/${row.inventory_id}`,
      admin,
      { quantity: 1000000, expected_version: row.version, reason: "perf setup" },
      "setup",
    );
    if (stocked.status !== 200) fail(`stock failed: ${stocked.status}`);
    actors.push({ email, password, customerId: customer.id, productId: product.id, warehouseId: warehouse.id });
  }
  return actors;
}

export function placeOrder(cookie, actor, name = "POST /orders", timeout = "30s") {
  return send(
    "POST",
    "/orders",
    cookie,
    { customer_id: actor.customerId, warehouse_id: actor.warehouseId, items: [{ product_id: actor.productId, quantity: 1 }] },
    name,
    {},
    timeout,
  );
}

export const uniqueKey = () => `perf-${__VU}-${__ITER}-${Date.now()}`;
