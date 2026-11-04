import { SEED, get, loginCookie, seconds } from "../lib.js";

export const options = {
  scenarios: {
    products: {
      executor: "ramping-vus",
      stages: [
        { duration: seconds(5), target: 20 },
        { duration: seconds(30), target: 20 },
        { duration: seconds(5), target: 0 },
      ],
    },
  },
};

export const setup = () => ({ cookie: loginCookie(SEED.viewer) });

const LISTS = [
  ["/products?page_size=20", "GET /products"],
  ["/products?page_size=20&sort=unit_price_cents&direction=desc", "GET /products sorted"],
  ["/products?q=drill", "GET /products search"],
  ["/products/categories", "GET /products/categories"],
];

export default function ({ cookie }) {
  const [path, name] = LISTS[__ITER % LISTS.length];
  get(path, cookie, name);
}
