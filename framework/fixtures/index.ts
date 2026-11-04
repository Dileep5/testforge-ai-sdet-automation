import { rm } from "node:fs/promises";
import {
  test as base,
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
  type PlaywrightWorkerArgs,
  type TestInfo,
} from "@playwright/test";
import { API_URL, BASE_URL, SESSION_COOKIE } from "../config";
import { TestData, testNamespace, type CreatedUser } from "../factories/test-data";
import { ApiClient } from "../helpers/api-client";
import { ReadOnlyDb } from "../helpers/database";
import type { Credentials, Customer, SessionUser } from "../helpers/types";
import { App } from "../pages/app";

/** Seeded accounts. They are only ever signed in as, and no test changes them. */
export const SEED_USERS = {
  admin: { email: "admin@testforge.example", password: "Admin!Forge2026" },
  manager: { email: "manager@testforge.example", password: "Manager!Forge2026" },
  viewer: { email: "viewer@testforge.example", password: "Viewer!Forge2026" },
} as const satisfies Record<string, Credentials>;

/** A signed-in browser with its own server-side session, plus an API client on that same session. */
export interface RoleSession {
  user: SessionUser;
  context: BrowserContext;
  page: Page;
  app: App;
  api: ApiClient;
  sessionCookie: () => Promise<string>;
}

export interface BuyerSession extends RoleSession {
  customer: Customer;
  credentials: CreatedUser;
}

/** A browser nobody has signed in to. */
export interface AnonymousSession {
  context: BrowserContext;
  page: Page;
  app: App;
}

type OpenBrowser = (storageState?: Awaited<ReturnType<APIRequestContext["storageState"]>>) => Promise<AnonymousSession>;
export type SignIn = (credentials: Credentials) => Promise<RoleSession>;

interface TestFixtures {
  /** Admin API client for test setup, with no browser attached. */
  setupApi: ApiClient;
  /** The test's own data. Cleaned up automatically, touching only what this test created. */
  data: TestData;
  /** Open an additional signed-in browser, for example as a user the test just created. */
  signIn: SignIn;
  anon: AnonymousSession;
  admin: RoleSession;
  manager: RoleSession;
  viewer: RoleSession;
  /** A customer-scoped Viewer belonging to a customer created just for this test. */
  buyer: BuyerSession;
  openBrowser: OpenBrowser;
}

interface WorkerFixtures {
  /** One read-only database connection per worker. */
  db: ReadOnlyDb;
}

type Playwright = PlaywrightWorkerArgs["playwright"];

export async function apiLogin(playwright: Playwright, credentials: Credentials, baseURL = BASE_URL): Promise<APIRequestContext> {
  const request = await playwright.request.newContext({ baseURL });
  const { email, password } = credentials;
  const response = await request.post("/api/v1/auth/login", { data: { email, password } });
  if (!response.ok()) {
    throw new Error(`Login as ${credentials.email} failed: ${response.status()} ${await response.text()}`);
  }
  return request;
}

/**
 * Contexts opened here get traces and screenshots from Playwright automatically. Video is only
 * automatic for the built-in `page` fixture, so it is recorded here and kept only for failures.
 */
function browserOpener(browser: Browser, testInfo: TestInfo) {
  const opened: { context: BrowserContext; page: Page; errors: string[] }[] = [];

  const open: OpenBrowser = async (storageState) => {
    const context = await browser.newContext({
      baseURL: BASE_URL,
      acceptDownloads: true,
      recordVideo: { dir: testInfo.outputPath("videos") },
      ...(storageState ? { storageState } : {}),
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    opened.push({ context, page, errors });
    return { context, page, app: new App(page) };
  };

  const closeAll = async () => {
    const failed = testInfo.status !== testInfo.expectedStatus;
    const uncaught = opened.flatMap((item) => item.errors);
    for (const { context, page } of opened) {
      const video = page.video();
      await context.close();
      if (failed && video) {
        await testInfo.attach("video", { path: await video.path(), contentType: "video/webm" });
      }
    }
    if (!failed) await rm(testInfo.outputPath("videos"), { recursive: true, force: true });
    // A crash in the page is a bug even when the visible assertions happen to pass.
    expect(uncaught, "uncaught errors in the page").toEqual([]);
  };

  return { open, closeAll };
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  db: [
    async ({}, use) => {
      const db = await ReadOnlyDb.connect();
      await use(db);
      await db.close();
    },
    { scope: "worker" },
  ],

  setupApi: async ({ playwright }, use) => {
    const request = await apiLogin(playwright, SEED_USERS.admin, API_URL);
    const api = new ApiClient(request);
    await use(api);
    await api.logout();
    await request.dispose();
  },

  data: async ({ setupApi }, use, testInfo) => {
    const data = new TestData(setupApi, testNamespace(testInfo));
    await use(data);
    const failures = await data.cleanup();
    expect(failures, "test data cleanup").toEqual([]);
  },

  openBrowser: async ({ browser }, use, testInfo) => {
    const { open, closeAll } = browserOpener(browser, testInfo);
    await use(open);
    await closeAll();
  },

  signIn: async ({ playwright, openBrowser }, use) => {
    const requests: APIRequestContext[] = [];
    await use(async (credentials) => {
      const request = await apiLogin(playwright, credentials);
      requests.push(request);
      const session = await openBrowser(await request.storageState());
      const api = new ApiClient(request);
      return {
        ...session,
        api,
        user: await api.me(),
        sessionCookie: async () => {
          const cookies = await session.context.cookies();
          const cookie = cookies.find((item) => item.name === SESSION_COOKIE);
          if (!cookie) throw new Error("The browser has no session cookie");
          return cookie.value;
        },
      };
    });
    await Promise.all(requests.map((request) => request.dispose()));
  },

  anon: async ({ openBrowser }, use) => {
    await use(await openBrowser());
  },
  admin: async ({ signIn }, use) => {
    await use(await signIn(SEED_USERS.admin));
  },
  manager: async ({ signIn }, use) => {
    await use(await signIn(SEED_USERS.manager));
  },
  viewer: async ({ signIn }, use) => {
    await use(await signIn(SEED_USERS.viewer));
  },
  buyer: async ({ signIn, data }, use) => {
    const customer = await data.customer();
    const credentials = await data.user("VIEWER", customer);
    await use({ ...(await signIn(credentials)), customer, credentials });
  },
});

export { expect };
