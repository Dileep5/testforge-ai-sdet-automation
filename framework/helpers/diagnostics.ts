import type { Browser, Page, Request, TestInfo } from "@playwright/test";

const MAX_ENTRIES = 200;

export interface PageDiagnostics {
  consoleErrors: { text: string; location: string }[];
  pageErrors: string[];
  failedRequests: { method: string; url: string; failure: string }[];
  errorResponses: { method: string; url: string; status: number; requestId: string | null }[];
  /** Requests still waiting when the report was written, which points to a timing failure. */
  pendingRequests: { method: string; url: string }[];
}

export function emptyDiagnostics(): PageDiagnostics {
  return { consoleErrors: [], pageErrors: [], failedRequests: [], errorResponses: [], pendingRequests: [] };
}

function push<T>(list: T[], item: T): void {
  if (list.length < MAX_ENTRIES) list.push(item);
}

/** Record what went wrong in the page. Only URLs and statuses are kept: no cookies, headers or bodies. */
export function watchPage(page: Page, record: PageDiagnostics): void {
  const pending = new Map<Request, { method: string; url: string }>();
  const finished = (request: Request) => {
    pending.delete(request);
    record.pendingRequests = [...pending.values()].slice(0, MAX_ENTRIES);
  };
  page.on("request", (request) => {
    pending.set(request, { method: request.method(), url: request.url() });
    record.pendingRequests = [...pending.values()].slice(0, MAX_ENTRIES);
  });
  page.on("requestfinished", finished);
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const { url, lineNumber } = message.location();
    push(record.consoleErrors, { text: message.text(), location: `${url}:${lineNumber}` });
  });
  page.on("pageerror", (error) => push(record.pageErrors, error.stack ?? error.message));
  page.on("requestfailed", (request) => {
    finished(request);
    push(record.failedRequests, { method: request.method(), url: request.url(), failure: request.failure()?.errorText ?? "unknown" });
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    push(record.errorResponses, {
      method: response.request().method(),
      url: response.url(),
      status: response.status(),
      requestId: response.headers()["x-request-id"] ?? null,
    });
  });
}

/** Everything needed to compare a failure with other runs, including one that does not reproduce. */
export function failureReport(testInfo: TestInfo, browser: Browser, pages: PageDiagnostics[]) {
  return {
    title: testInfo.titlePath.join(" > "),
    file: `${testInfo.file}:${testInfo.line}`,
    project: testInfo.project.name,
    browser: `${browser.browserType().name()} ${browser.version()}`,
    status: testInfo.status,
    expectedStatus: testInfo.expectedStatus,
    retry: testInfo.retry,
    repeatEachIndex: testInfo.repeatEachIndex,
    workerIndex: testInfo.workerIndex,
    parallelIndex: testInfo.parallelIndex,
    durationMs: testInfo.duration,
    finishedAt: new Date().toISOString(),
    errors: testInfo.errors.map((error) => error.message),
    pages,
  };
}
