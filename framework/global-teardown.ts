import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RUN_DIR } from "./config";
import { OpenApiContract } from "./contract/openapi";

const DIR = path.resolve(__dirname, "..", RUN_DIR, "contract");

/** Summarise which documented operations and statuses the run's real traffic reached. */
export default function globalTeardown(): void {
  if (!existsSync(DIR)) return;
  const seen = new Map<string, Set<string>>();
  for (const file of readdirSync(DIR).filter((name) => name.endsWith(".jsonl"))) {
    for (const line of readFileSync(path.join(DIR, file), "utf8").split("\n").filter(Boolean)) {
      const { operation, status } = JSON.parse(line) as { operation: string; status: number };
      seen.set(operation, (seen.get(operation) ?? new Set()).add(String(status)));
    }
  }
  const { operations } = new OpenApiContract();
  const rows = operations.map(({ key, definition }) => {
    const statuses = seen.get(key) ?? new Set<string>();
    const documented = Object.keys(definition.responses);
    return { key, reached: documented.filter((item) => statuses.has(item)), missed: documented.filter((item) => !statuses.has(item)) };
  });
  const lines = [
    "# API contract coverage of the last run",
    "",
    "| Operation | Statuses reached | Documented but not reached |",
    "| --- | --- | --- |",
    ...rows.map((row) => `| ${row.key} | ${row.reached.join(", ")} | ${row.missed.join(", ")} |`),
  ];
  mkdirSync(DIR, { recursive: true });
  writeFileSync(path.join(DIR, "coverage.md"), `${lines.join("\n")}\n`);
  const reached = rows.filter((row) => row.reached.length > 0).length;
  const total = rows.reduce((sum, row) => sum + row.reached.length + row.missed.length, 0);
  const statuses = rows.reduce((sum, row) => sum + row.reached.length, 0);
  console.log(`[contract] ${reached} of ${rows.length} operations reached; ${statuses} of ${total} documented responses reached`);
}
