// Pass or fail gates for k6. These catch large regressions on a known machine. They are NOT service
// level objectives, and passing them says nothing about production capacity.
//
// PERF_PROFILE chooses the limits: "local" is about 3x what the fanless development laptop measured,
// and "ci" adds margin for shared runners, whose speed varies. PERF_P95_MS overrides any p95 limit.

const P95_MS = {
  local: { health: 50, products: 100, orders: 200, auth: 800, "order-create": 150, mixed: 500 },
  ci: { health: 500, products: 1000, orders: 1500, auth: 3000, "order-create": 1500, mixed: 3000 },
};
const REFUSAL_P95_MS = { local: 100, ci: 1000 };

const profile = __ENV.PERF_PROFILE || "local";
if (!P95_MS[profile]) throw new Error(`Unknown PERF_PROFILE: ${profile}`);
const override = Number(__ENV.PERF_P95_MS || 0);
const limit = (value) => override || value;

/** Normal load: nearly no errors, latency within limits, and only the statuses this traffic should get. */
export function loadThresholds(name) {
  const scenario = name.replace("-", "_");
  return {
    [`http_req_failed{scenario:${scenario}}`]: ["rate<0.01"],
    [`http_req_duration{scenario:${scenario}}`]: [`p(95)<${limit(P95_MS[profile][name])}`],
    [`status_4xx{scenario:${scenario}}`]: ["rate<0.01"],
    [`status_5xx{scenario:${scenario}}`]: ["rate==0"],
  };
}

/**
 * Overload: excess work is refused quickly with a 503 and nothing else, no client is left waiting
 * until it gives up, and traffic after the peak is served normally.
 */
export function overloadThresholds() {
  return {
    "other_5xx{scenario:overload}": ["count==0"],
    "client_no_response{scenario:overload}": ["count==0"],
    "refused_503{scenario:overload}": ["rate>0"],
    refused_duration: [`p(95)<${limit(REFUSAL_P95_MS[profile])}`],
    "http_req_failed{scenario:after}": ["rate==0"],
    "client_no_response{scenario:after}": ["count==0"],
  };
}
