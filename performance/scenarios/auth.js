import http from "k6/http";
import { API, SEED, seconds } from "../lib.js";

// Password hashing is deliberately slow, so this measures Argon2 as well as the API.
export const options = {
  scenarios: { auth: { executor: "constant-vus", vus: 10, duration: seconds(30) } },
};

export default function () {
  http.post(`${API}/auth/login`, JSON.stringify(SEED.viewer), {
    headers: { "Content-Type": "application/json" },
    tags: { name: "POST /auth/login" },
  });
  http.get(`${API}/auth/me`, { tags: { name: "GET /auth/me" } });
  http.post(`${API}/auth/logout`, null, { tags: { name: "POST /auth/logout" } });
}
