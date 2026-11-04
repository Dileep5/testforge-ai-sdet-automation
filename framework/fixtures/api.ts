import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { API_URL, SESSION_COOKIE } from "../config";
import { OpenApiContract } from "../contract/openapi";
import type { CreatedUser } from "../factories/test-data";
import { ApiClient, type ResponseObserver } from "../helpers/api-client";
import type { Credentials, Customer, SessionUser } from "../helpers/types";
import { SEED_USERS, apiLogin, expect, test as base } from "./index";

/** A signed-in API session with no browser. */
export interface ApiSession {
  api: ApiClient;
  user: SessionUser;
  credentials: Credentials;
  sessionCookie: () => Promise<string>;
}

export interface ApiBuyer extends ApiSession {
  customer: Customer;
  credentials: CreatedUser;
}

interface ApiFixtures {
  /** Records every response in the test, and fails the test if any breaks the API contract. */
  observeContract: ResponseObserver;
  /** A client with no session. */
  anonymous: ApiClient;
  /** A client with no session and no contract check, for paths the spec deliberately omits. */
  unchecked: ApiClient;
  /** A client presenting exactly this cookie value, for replaying old or forged tokens. */
  withCookie: (value: string) => Promise<ApiClient>;
  /** Log in with any credentials. Each call is a separate server-side session. */
  loginAs: (credentials: Credentials) => Promise<ApiSession>;
  /** Create a customer with its own customer-scoped Viewer, and log in. */
  newBuyer: () => Promise<ApiBuyer>;
  asAdmin: ApiSession;
  asManager: ApiSession;
  asViewer: ApiSession;
  asBuyer: ApiBuyer;
}

const contract = new OpenApiContract();

export const test = base.extend<ApiFixtures>({
  observeContract: async ({}, use, testInfo) => {
    const violations: string[] = [];
    const reached = new Set<string>();
    await use(async (method, requestPath, response) => {
      const pathOnly = requestPath.split("?")[0] ?? requestPath;
      const headers = response.headers();
      const media = headers["content-type"] ?? "";
      const body = media.startsWith("application/json") || response.status() === 204 ? await response.text() : "";
      violations.push(
        ...contract.checkResponse({ method, path: pathOnly, status: response.status(), headers, body }),
      );
      const operation = contract.find(method, pathOnly);
      if (operation) reached.add(JSON.stringify({ operation: operation.key, status: response.status() }));
    });
    const dir = path.resolve(__dirname, "../../reports/contract");
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, `observed-${testInfo.parallelIndex}.jsonl`), [...reached, ""].join("\n"));
    expect(violations, "responses that break the OpenAPI contract").toEqual([]);
  },

  setupApi: async ({ playwright, observeContract }, use) => {
    const request = await apiLogin(playwright, SEED_USERS.admin, API_URL);
    const api = new ApiClient(request, observeContract);
    await use(api);
    await api.logout();
    await request.dispose();
  },

  anonymous: async ({ playwright, observeContract }, use) => {
    const request = await playwright.request.newContext({ baseURL: API_URL });
    await use(new ApiClient(request, observeContract));
    await request.dispose();
  },

  unchecked: async ({ playwright }, use) => {
    const request = await playwright.request.newContext({ baseURL: API_URL });
    await use(new ApiClient(request));
    await request.dispose();
  },

  withCookie: async ({ playwright, observeContract }, use) => {
    const requests: APIRequestContext[] = [];
    await use(async (value) => {
      const request = await playwright.request.newContext({
        baseURL: API_URL,
        extraHTTPHeaders: { Cookie: `${SESSION_COOKIE}=${value}` },
      });
      requests.push(request);
      return new ApiClient(request, observeContract);
    });
    await Promise.all(requests.map((request) => request.dispose()));
  },

  loginAs: async ({ playwright, observeContract }, use) => {
    const requests: APIRequestContext[] = [];
    await use(async (credentials) => {
      const request = await apiLogin(playwright, credentials, API_URL);
      requests.push(request);
      const api = new ApiClient(request, observeContract);
      return {
        api,
        credentials,
        user: await api.me(),
        sessionCookie: async () => {
          const { cookies } = await request.storageState();
          const cookie = cookies.find((item) => item.name === SESSION_COOKIE);
          if (!cookie) throw new Error("This session has no cookie");
          return cookie.value;
        },
      };
    });
    await Promise.all(requests.map((request) => request.dispose()));
  },

  newBuyer: async ({ data, loginAs }, use) => {
    await use(async () => {
      const customer = await data.customer();
      const credentials = await data.user("VIEWER", customer);
      return { ...(await loginAs(credentials)), customer, credentials };
    });
  },

  asAdmin: async ({ loginAs }, use) => {
    await use(await loginAs(SEED_USERS.admin));
  },
  asManager: async ({ loginAs }, use) => {
    await use(await loginAs(SEED_USERS.manager));
  },
  asViewer: async ({ loginAs }, use) => {
    await use(await loginAs(SEED_USERS.viewer));
  },
  asBuyer: async ({ newBuyer }, use) => {
    await use(await newBuyer());
  },
});

export { expect };
