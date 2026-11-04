import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { API_DATABASE_URL, DATABASE_URL, READONLY_DATABASE_URL, READONLY_ROLE, RUN_DIR, RUN_ID, assertE2eDatabase } from "./config";

/** Give SQL assertions a login that can read this one database and write nothing, anywhere. */
async function provisionReadOnlyRole(): Promise<void> {
  const password = new URL(READONLY_DATABASE_URL).password;
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const { rowCount } = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [READONLY_ROLE]);
    if (!rowCount) await client.query(`CREATE ROLE ${READONLY_ROLE} LOGIN PASSWORD '${password}'`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${READONLY_ROLE}`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${READONLY_ROLE}`);
  } finally {
    await client.end();
  }
}

/** Give every run the same deterministic starting data. Only ever touches the E2E database. */
export default async function globalSetup(): Promise<void> {
  assertE2eDatabase();
  // In Docker Compose a one-shot service seeds the database, and this image has no Python.
  if (!process.env.E2E_SKIP_SEED) {
    const apiDir = path.resolve(__dirname, "../apps/api");
    const output = execFileSync(path.join(apiDir, ".venv/bin/python"), ["-m", "app.seed", "--reset"], {
      cwd: apiDir,
      env: { ...process.env, APP_ENV: "test", DATABASE_URL: API_DATABASE_URL },
      encoding: "utf8",
    });
    console.log(`[e2e] ${output.trim()}`);
  }
  await provisionReadOnlyRole();
  const reports = path.resolve(__dirname, "../reports");
  mkdirSync(reports, { recursive: true });
  writeFileSync(path.join(reports, "latest-run.txt"), `${RUN_ID}\n`);
  console.log(`[e2e] Reports and failure artifacts: ${RUN_DIR}`);
}
