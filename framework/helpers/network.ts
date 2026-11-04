import type { Page, Response } from "@playwright/test";

export interface ApiMatch {
  method?: string;
  /** Matched against the path after /api/v1. */
  path: string | RegExp;
  /** Query parameters that must be present with exactly these values. */
  params?: Record<string, string>;
  /** Exact parameters: anything not listed must be absent. */
  exactParams?: boolean;
}

function matches(response: Response, match: ApiMatch): boolean {
  const url = new URL(response.url());
  if (!url.pathname.startsWith("/api/v1")) return false;
  if (match.method && response.request().method() !== match.method) return false;
  const path = url.pathname.slice("/api/v1".length);
  const pathOk = typeof match.path === "string" ? path === match.path : match.path.test(path);
  if (!pathOk) return false;
  const params = match.params ?? {};
  if (Object.entries(params).some(([key, value]) => url.searchParams.get(key) !== value)) return false;
  return !match.exactParams || [...url.searchParams.keys()].every((key) => key in params);
}

/**
 * Run an action and wait for the API response it causes. The wait is registered before the action
 * starts, so a fast response can never be missed.
 */
export async function whileWaitingFor(page: Page, match: ApiMatch, action: () => Promise<void>): Promise<Response> {
  const [response] = await Promise.all([page.waitForResponse((candidate) => matches(candidate, match)), action()]);
  return response;
}

/**
 * Run an action just before the nth matching request is sent, to place a change from another user
 * at an exact point in a multi-request read. The request itself still goes to the real server.
 */
export async function beforeNthRequest(page: Page, url: RegExp, n: number, action: () => Promise<void>): Promise<void> {
  let seen = 0;
  await page.route(url, async (route) => {
    seen += 1;
    if (seen === n) await action();
    await route.continue();
  });
}
