import { get, seconds } from "../lib.js";
import { loadThresholds } from "../thresholds.js";

export const options = {
  thresholds: loadThresholds("health"),
  scenarios: { health: { executor: "constant-vus", vus: 20, duration: seconds(30) } },
};

export default function () {
  get("/health", "", "GET /health");
  get("/ready", "", "GET /ready");
}
