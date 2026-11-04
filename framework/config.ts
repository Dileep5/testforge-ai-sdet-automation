/** Where the E2E environment lives. It is fully separate from the dev API, web app and database. */
export const API_PORT = Number(process.env.E2E_API_PORT ?? 8100);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5273);
export const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${WEB_PORT}`;
export const API_URL = `http://127.0.0.1:${API_PORT}`;

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

export const SESSION_COOKIE = "testforge_session";
export const PAYMENT_SIM_TIMEOUT_MS = 300;
