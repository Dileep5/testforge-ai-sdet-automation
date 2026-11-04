import { execFileSync } from "node:child_process";
import path from "node:path";
import { API_DATABASE_URL, assertE2eDatabase } from "./config";

/** Give every run the same deterministic starting data. Only ever touches the E2E database. */
export default function globalSetup(): void {
  assertE2eDatabase();
  const apiDir = path.resolve(__dirname, "../apps/api");
  const output = execFileSync(path.join(apiDir, ".venv/bin/python"), ["-m", "app.seed", "--reset"], {
    cwd: apiDir,
    env: { ...process.env, APP_ENV: "test", DATABASE_URL: API_DATABASE_URL },
    encoding: "utf8",
  });
  console.log(`[e2e] ${output.trim()}`);
}
