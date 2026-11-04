/** Where the E2E environment lives. It is fully separate from the dev API, web app and database. */
export const API_PORT = Number(process.env.E2E_API_PORT ?? 8100);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5273);
export const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${WEB_PORT}`;
export const API_URL = process.env.E2E_API_URL ?? `http://127.0.0.1:${API_PORT}`;

/**
 * Every run reports to its own folder, because Playwright empties its output folder when it starts
 * and would otherwise destroy the evidence of an earlier failure. Workers inherit this variable, so
 * they share one run. CI sets it to name the job.
 */
export const RUN_ID = (process.env.TESTFORGE_RUN_ID ??= `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
if (!/^[\w.-]+$/.test(RUN_ID)) throw new Error("TESTFORGE_RUN_ID may only use letters, digits, dots, dashes and underscores");
export const RUN_DIR = `reports/runs/${RUN_ID}`;

/** libpq-style URL; the API needs the SQLAlchemy driver prefix added. */
export const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql://testforge:testforge_local@127.0.0.1:55432/testforge_e2e";
export const API_DATABASE_URL = DATABASE_URL.replace(/^postgresql:/, "postgresql+psycopg:");

/** The run wipes this database, so never let it point anywhere else. */
export function assertE2eDatabase(url: string = DATABASE_URL): void {
  if (!new URL(url).pathname.endsWith("_e2e")) {
    throw new Error(`Refusing to use ${new URL(url).pathname}: the E2E database name must end in _e2e`);
  }
}

/**
 * SQL assertions connect as a role that only holds SELECT on this database. Unlike a read-only
 * session setting, a query cannot switch this off, and the role has no access to other databases' tables.
 */
export const READONLY_ROLE = "testforge_e2e_reader";
function readOnlyUrl(url: string): string {
  const parsed = new URL(url);
  parsed.username = READONLY_ROLE;
  parsed.password = "testforge_e2e_reader_local";
  return parsed.toString();
}
export const READONLY_DATABASE_URL = readOnlyUrl(DATABASE_URL);
/** The same read-only role, aimed at the development database, to prove it has no access there. */
export const READONLY_DEV_DATABASE_URL = (() => {
  const parsed = new URL(READONLY_DATABASE_URL);
  parsed.pathname = parsed.pathname.replace(/_e2e$/, "");
  return parsed.toString();
})();

export const SESSION_COOKIE = "testforge_session";
export const PAYMENT_SIM_TIMEOUT_MS = 300;
