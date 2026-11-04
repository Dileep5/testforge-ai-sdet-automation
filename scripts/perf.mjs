#!/usr/bin/env node
// Run k6 scenarios against a dedicated API and database, and report what was actually measured.
// Usage: node scripts/perf.mjs [--label name] [scenario ...]
import { execFileSync, spawn } from "node:child_process";
import { pbkdf2Sync } from "node:crypto";
import { createInterface } from "node:readline";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = path.join(ROOT, "apps/api");
const K6 = path.join(ROOT, ".local/k6/k6");
const PORT = 8200;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_URL = process.env.PERF_DATABASE_URL ?? "postgresql://testforge:testforge_local@127.0.0.1:55432/testforge_perf";
const ALL = ["health", "products", "orders", "auth", "order-create", "mixed", "overload"];

const args = process.argv.slice(2);
const labelAt = args.indexOf("--label");
const label = labelAt >= 0 ? args[labelAt + 1] : "latest";
const chosen = args.filter((item, index) => index !== labelAt && index !== labelAt + 1);
const scenarios = chosen.length ? chosen : ALL;
const OUT = path.join(ROOT, "reports/performance", label);

// Each run replaces all data here, so never let this point at anything else.
if (!new URL(DB_URL).pathname.endsWith("_perf")) throw new Error("PERF_DATABASE_URL must name a database ending in _perf");
if (!existsSync(K6)) throw new Error("k6 is not installed. Run: npm run perf:install");

const apiEnv = {
  ...process.env,
  APP_ENV: "test",
  DATABASE_URL: DB_URL.replace(/^postgresql:/, "postgresql+psycopg:"),
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value, digits = 1) => Number(value.toFixed(digits));

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

function stats(samples) {
  const times = samples.map((sample) => sample.value).sort((a, b) => a - b);
  const statuses = {};
  for (const sample of samples) {
    const key = sample.status === "0" ? `0 (${sample.error || "no response"})` : sample.status;
    statuses[key] = (statuses[key] ?? 0) + 1;
  }
  const start = samples.reduce((min, sample) => Math.min(min, sample.time), Infinity);
  const end = samples.reduce((max, sample) => Math.max(max, sample.time), 0);
  const duration = Math.max((end - start) / 1000, 0.001);
  const failed = samples.filter((sample) => sample.status === "0" || Number(sample.status) >= 500).length;
  return {
    requests: samples.length,
    duration_s: round(duration),
    rps: round(samples.length / duration),
    p50_ms: round(quantile(times, 0.5)),
    p95_ms: round(quantile(times, 0.95)),
    p99_ms: round(quantile(times, 0.99)),
    max_ms: round(times.at(-1) ?? 0),
    error_rate_pct: samples.length ? round((failed / samples.length) * 100, 2) : 0,
    statuses,
  };
}

async function summarise(file) {
  const samples = [];
  let peakVus = 0;
  const lines = createInterface({ input: createReadStream(file) });
  for await (const line of lines) {
    if (!line.includes('"type":"Point"')) continue;
    const point = JSON.parse(line);
    if (point.metric === "vus") peakVus = Math.max(peakVus, point.data.value);
    if (point.metric !== "http_req_duration") continue;
    const { tags, value, time } = point.data;
    if (tags.name === "setup" || tags.scenario === "setup" || tags.group === "::setup") continue;
    samples.push({
      value,
      time: Date.parse(time),
      status: tags.status ?? "0",
      error: tags.error_code,
      scenario: tags.scenario ?? "default",
      name: tags.name ?? "other",
    });
  }
  const groupBy = (key) => {
    const groups = {};
    for (const sample of samples) (groups[sample[key]] ??= []).push(sample);
    return Object.fromEntries(Object.entries(groups).map(([name, items]) => [name, stats(items)]));
  };
  // Throughput and errors over time, which show whether the API recovers.
  const first = samples.reduce((min, sample) => Math.min(min, sample.time), Infinity);
  const buckets = {};
  for (const sample of samples) (buckets[Math.floor((sample.time - first) / 10000) * 10] ??= []).push(sample);
  const timeline = Object.entries(buckets).map(([second, items]) => ({ second: Number(second), ...stats(items), duration_s: undefined, statuses: stats(items).statuses }));
  // Refusals are very fast, so one combined percentile would hide what served requests experienced.
  const outcome = (sample) => (sample.status === "0" ? "no response" : Number(sample.status) >= 500 ? "refused or failed" : "served");
  const overloadSamples = samples.filter((sample) => sample.scenario === "overload");
  const outcomes = {};
  for (const sample of overloadSamples) (outcomes[outcome(sample)] ??= []).push(sample);
  const overloadOutcomes = Object.fromEntries(Object.entries(outcomes).map(([name, items]) => [name, stats(items)]));
  // When errors happened after the peak: right at the start means draining, and later means no recovery.
  const afterSamples = samples.filter((sample) => sample.scenario === "after");
  const afterStart = afterSamples.reduce((min, sample) => Math.min(min, sample.time), Infinity);
  const afterErrors = afterSamples.filter((sample) => sample.status === "0" || Number(sample.status) >= 500);
  const recovery = afterSamples.length
    ? { errors: afterErrors.length, last_error_s_after_start: afterErrors.length ? round(Math.max(...afterErrors.map((sample) => sample.time - afterStart)) / 1000, 2) : null }
    : undefined;
  return { overall: stats(samples), peak_vus: peakVus, recovery, overload_outcomes: overloadOutcomes, by_scenario: groupBy("scenario"), by_request: groupBy("name"), timeline };
}

/** Each threshold and its result, from k6's own export. In this format, true means the rule was crossed. */
function readThresholds(file) {
  if (!existsSync(file)) return [];
  const { metrics } = JSON.parse(readFileSync(file, "utf8"));
  rmSync(file, { force: true });
  return Object.entries(metrics).flatMap(([metric, data]) =>
    Object.entries(data.thresholds ?? {}).map(([rule, crossed]) => ({ metric, rule, passed: !crossed })),
  );
}

/** The same fixed CPU work before each scenario. If this moves, so will every latency: compare with care. */
function calibrateCpuMs() {
  const started = performance.now();
  pbkdf2Sync("calibration", "salt", 300000, 32, "sha256");
  return round(performance.now() - started);
}

function thermalState() {
  try {
    return execFileSync("pmset", ["-g", "therm"], { encoding: "utf8" }).match(/CPU_Speed_Limit\s*=\s*\d+/)?.[0] ?? "no CPU speed limit reported";
  } catch {
    return "not available";
  }
}

async function databaseFacts(client) {
  const settings = {};
  for (const name of ["server_version", "max_connections", "shared_buffers", "work_mem", "effective_cache_size", "synchronous_commit", "fsync", "wal_level"]) {
    settings[name] = (await client.query(`SHOW ${name}`)).rows[0][name];
  }
  return settings;
}

async function connectionState(client) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_transaction,
            count(*) FILTER (WHERE state = 'active')::int AS active
       FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`,
  );
  return rows[0];
}

async function waitUntilReady() {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const response = await fetch(`${BASE_URL}/api/v1/ready`);
      if (response.ok) return;
    } catch {
      // Still starting.
    }
    await sleep(100);
  }
  throw new Error("The API did not become ready");
}

async function runScenario(name, admin) {
  console.log(`\n=== ${name} ===`);
  execFileSync(".venv/bin/python", ["-m", "app.seed", "--reset"], { cwd: API_DIR, env: apiEnv, stdio: "ignore" });

  const server = spawn(".venv/bin/uvicorn", ["app.main:app", "--host", "127.0.0.1", "--port", String(PORT), "--log-level", "warning", "--no-access-log"], {
    cwd: API_DIR,
    env: apiEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let serverLog = "";
  server.stderr.on("data", (chunk) => {
    serverLog += chunk;
  });
  try {
    await waitUntilReady();
    const load = os.loadavg()[0];
    const calibration = { cpu_ms: calibrateCpuMs(), thermal: thermalState() };

    let peak = { total: 0, idle_in_transaction: 0, active: 0 };
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const now = await connectionState(admin);
        peak = { total: Math.max(peak.total, now.total), idle_in_transaction: Math.max(peak.idle_in_transaction, now.idle_in_transaction), active: Math.max(peak.active, now.active) };
        await sleep(500);
      }
    })();

    const raw = path.join(OUT, `${name}.raw.json`);
    const exported = path.join(OUT, `${name}.k6-summary.json`);
    const started = Date.now();
    const k6 = spawn(K6, ["run", "--quiet", "--summary-mode", "compact", "--summary-export", exported, "--out", `json=${raw}`, "--system-tags", "status,error_code,scenario,name,method,group", "-e", `PERF_BASE_URL=${BASE_URL}`, "-e", `PERF_RUN_ID=${Date.now()}`, "-e", `PERF_SCALE=${process.env.PERF_SCALE ?? "1"}`, "-e", `PERF_PEAK_VUS=${process.env.PERF_PEAK_VUS ?? "300"}`, "-e", `PERF_PROFILE=${process.env.PERF_PROFILE ?? "local"}`, "-e", `PERF_P95_MS=${process.env.PERF_P95_MS ?? ""}`, path.join(ROOT, `performance/scenarios/${name}.js`)], { stdio: ["ignore", "ignore", "pipe"] });
    // Script errors and timeouts can be numerous, so keep a count of each kind, not every line.
    const k6Messages = {};
    createInterface({ input: k6.stderr }).on("line", (line) => {
      const message = (/msg="([^"]*)/.exec(line)?.[1] ?? line).replace(/[0-9a-f-]{36}/g, "<id>").slice(0, 120);
      k6Messages[message] = (k6Messages[message] ?? 0) + 1;
    });
    const exitCode = await new Promise((resolve) => k6.on("exit", resolve));
    const wall = (Date.now() - started) / 1000;
    sampling = false;
    await sampler;

    // After the load stops: does the API answer, and are connections returned rather than leaked?
    const afterStart = Date.now();
    await waitUntilReady();
    const readyAfterMs = Date.now() - afterStart;
    let settled = await connectionState(admin);
    for (let attempt = 0; attempt < 60 && (settled.idle_in_transaction > 0 || settled.active > 0); attempt++) {
      await sleep(500);
      settled = await connectionState(admin);
    }

    const summary = {
      scenario: name,
      k6_exit_code: exitCode,
      thresholds: readThresholds(exported),
      k6_messages: k6Messages,
      wall_clock_s: round(wall),
      load_average_at_start: round(load, 2),
      calibration,
      max_queued_requests: process.env.MAX_QUEUED_REQUESTS ?? "default",
      max_queue_wait_seconds: process.env.MAX_QUEUE_WAIT_SECONDS ?? "default",
      ...(await summarise(raw)),
      database_connections: { peak, settled_after_load: settled },
      ready_after_load_ms: readyAfterMs,
      server_errors_logged: (serverLog.match(/^(Traceback|ERROR)/gm) ?? []).length,
      pool_timeouts_logged: (serverLog.match(/QueuePool limit/g) ?? []).length,
    };
    rmSync(raw, { force: true });
    writeFileSync(path.join(OUT, `${name}.json`), `${JSON.stringify(summary, null, 2)}\n`);
    const { overall, peak_vus: vus } = summary;
    console.log(`calibration ${calibration.cpu_ms} ms, load ${round(load, 1)}`);
    console.log(`${overall.requests} requests, ${overall.rps} req/s, p50 ${overall.p50_ms} ms, p95 ${overall.p95_ms} ms, p99 ${overall.p99_ms} ms, errors ${overall.error_rate_pct}%, peak VUs ${vus}`);
    for (const item of summary.thresholds) console.log(`  ${item.passed ? "PASS" : "FAIL"}  ${item.metric}: ${item.rule}`);
    if (Object.keys(k6Messages).length) console.log(`k6 messages ${JSON.stringify(k6Messages).slice(0, 400)}`);
    if (summary.recovery) console.log(`after the peak: ${JSON.stringify(summary.recovery)}`);
    console.log(`statuses ${JSON.stringify(overall.statuses)}; connections peak ${JSON.stringify(peak)}, after ${JSON.stringify(settled)}`);
    return summary;
  } finally {
    server.kill("SIGTERM");
    await new Promise((resolve) => server.on("exit", resolve));
  }
}

function environment(database) {
  const exec = (cmd, list) => execFileSync(cmd, list, { encoding: "utf8" }).trim();
  const mac = process.platform === "darwin";
  return {
    recorded_at: new Date().toISOString(),
    profile: process.env.PERF_PROFILE ?? "local",
    machine: `${os.cpus()[0]?.model ?? "unknown CPU"}, ${os.cpus().length} cores, ${round(os.totalmem() / 2 ** 30, 0)} GB`,
    os: mac ? `macOS ${exec("sw_vers", ["-productVersion"])}` : `${os.type()} ${os.release()}`,
    listen_queue_limit: mac ? exec("sysctl", ["-n", "kern.ipc.somaxconn"]) : readFileSync("/proc/sys/net/core/somaxconn", "utf8").trim(),
    node: process.version,
    python: exec(path.join(API_DIR, ".venv/bin/python"), ["--version"]),
    k6: exec(K6, ["version"]).split(" ").slice(0, 2).join(" "),
    server: "one uvicorn process on the same machine as k6 and PostgreSQL, access log off",
    database,
  };
}

mkdirSync(OUT, { recursive: true });
const admin = new pg.Client({ connectionString: DB_URL });
await admin.connect();
const env = environment(await databaseFacts(admin));
writeFileSync(path.join(OUT, "environment.json"), `${JSON.stringify(env, null, 2)}\n`);
console.log(JSON.stringify(env, null, 2));
let failed = false;
for (const name of scenarios) {
  const result = await runScenario(name, admin);
  failed ||= result.k6_exit_code !== 0;
}
await admin.end();
if (failed) process.exitCode = 1;
