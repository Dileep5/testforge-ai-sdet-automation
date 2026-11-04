import { get, seconds } from "../lib.js";

export const options = {
  scenarios: { health: { executor: "constant-vus", vus: 20, duration: seconds(30) } },
};

export default function () {
  get("/health", "", "GET /health");
  get("/ready", "", "GET /ready");
}
