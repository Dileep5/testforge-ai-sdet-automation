#!/usr/bin/env node
// Inspect and tidy the per-run report folders. Runs with failures are kept unless explicitly included.
//   node scripts/reports.mjs check [--run id] [--min-tests n]    fail on failures, flaky, skipped or too few tests
//   node scripts/reports.mjs prune [--keep 20] [--days 14] [--include-failed] [--dry-run]
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = path.join(ROOT, "reports/runs");
const [command, ...rest] = process.argv.slice(2);

function option(name, fallback) {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 ? rest[at + 1] : fallback;
}

function stats(run) {
  const file = path.join(RUNS, run, "playwright.json");
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")).stats;
}

function check() {
  const latest = path.join(ROOT, "reports/latest-run.txt");
  const run = option("run", process.env.TESTFORGE_RUN_ID ?? (existsSync(latest) ? readFileSync(latest, "utf8").trim() : undefined));
  if (!run) throw new Error("No run to check");
  const result = stats(run);
  const minimum = Number(option("min-tests", 1));
  const problems = [];
  if (!result) problems.push("no JSON report: the suite may not have run");
  else {
    const { expected, unexpected, flaky, skipped } = result;
    console.log(`${run}: passed ${expected}, failed ${unexpected}, flaky ${flaky}, skipped ${skipped}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `| ${run} | ${expected} | ${unexpected} | ${flaky} | ${skipped} |\n`);
    }
    if (unexpected) problems.push(`${unexpected} failed`);
    if (flaky) problems.push(`${flaky} flaky`);
    if (skipped) problems.push(`${skipped} skipped`);
    if (expected < minimum) problems.push(`only ${expected} passed, and at least ${minimum} must`);
  }
  if (problems.length) {
    console.error(`Quality gate failed for ${run}: ${problems.join("; ")}`);
    process.exitCode = 1;
  }
}

function prune() {
  if (!existsSync(RUNS)) return;
  const keep = Number(option("keep", 20));
  const days = Number(option("days", 14));
  const includeFailed = rest.includes("--include-failed");
  const dryRun = rest.includes("--dry-run");
  const runs = readdirSync(RUNS)
    .map((name) => ({ name, modified: statSync(path.join(RUNS, name)).mtimeMs }))
    .sort((a, b) => b.modified - a.modified);
  const cutoff = Date.now() - days * 86_400_000;
  let removed = 0;
  runs.forEach(({ name, modified }, index) => {
    if (index < keep || modified > cutoff) return;
    const result = stats(name);
    const failed = !result || result.unexpected > 0 || result.flaky > 0;
    if (failed && !includeFailed) {
      console.log(`Keeping ${name}: it has failures, or no report`);
      return;
    }
    console.log(`${dryRun ? "Would remove" : "Removing"} ${name}`);
    if (!dryRun) rmSync(path.join(RUNS, name), { recursive: true, force: true });
    removed += 1;
  });
  console.log(`${runs.length} runs, ${removed} ${dryRun ? "would be " : ""}removed`);
}

if (command === "check") check();
else if (command === "prune") prune();
else {
  console.error("Usage: reports.mjs check|prune");
  process.exitCode = 2;
}
