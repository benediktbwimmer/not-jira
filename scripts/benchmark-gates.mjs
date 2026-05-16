#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const artifactsDir = resolve(repoRoot, process.env.UNBLOCK_BENCH_ARTIFACT_DIR ?? "artifacts/benchmark");
const runId = sanitize(process.env.UNBLOCK_BENCH_RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-"));
const postgresUrl = process.env.UNBLOCK_BENCH_POSTGRES_URL ?? process.env.UNBLOCK_POSTGRES_URL;
const hostedPostgresUrl = process.env.UNBLOCK_BENCH_HOSTED_POSTGRES_URL ?? process.env.UNBLOCK_HOSTED_POSTGRES_URL;
const baselinePath = process.env.UNBLOCK_BENCH_BASELINE
  ? resolve(repoRoot, process.env.UNBLOCK_BENCH_BASELINE)
  : resolve(repoRoot, "docs/benchmark-baseline.json");
const minimumRegressionRatio = numericEnv("UNBLOCK_BENCH_MIN_BASELINE_RATIO", 0.75);

await mkdir(artifactsDir, { recursive: true });
await run("npm", ["run", "build", "-w", "@unblock/cli"]);

const matrixArgs = [
  "packages/cli/dist/index.js",
  "--format",
  "json",
  "bench",
  "matrix",
  "--run-id",
  runId,
  "--project-prefix",
  "CI-BENCH",
  "--modes",
  process.env.UNBLOCK_BENCH_MODES ?? "sqlite,postgres,hosted",
  "--scenarios",
  process.env.UNBLOCK_BENCH_SCENARIOS ?? "storage,matcher,connector",
  "--tasks",
  integerEnv("UNBLOCK_BENCH_STORAGE_TASKS", 250),
  "--updates",
  integerEnv("UNBLOCK_BENCH_STORAGE_UPDATES", 125),
  "--dependency-mutations",
  integerEnv("UNBLOCK_BENCH_DEPENDENCY_MUTATIONS", 50),
  "--read-tasks",
  integerEnv("UNBLOCK_BENCH_READ_TASKS", 500),
  "--iterations",
  integerEnv("UNBLOCK_BENCH_READ_ITERATIONS", 5),
  "--pollers",
  integerEnv("UNBLOCK_BENCH_POLLERS", 8),
  "--connector-tasks",
  integerEnv("UNBLOCK_BENCH_CONNECTOR_TASKS", 250),
  "--connector-events",
  integerEnv("UNBLOCK_BENCH_CONNECTOR_EVENTS", 250),
  "--connector-queue-items",
  integerEnv("UNBLOCK_BENCH_CONNECTOR_QUEUE_ITEMS", 250),
  "--connector-reads",
  integerEnv("UNBLOCK_BENCH_CONNECTOR_READS", 10),
  "--min-storage-ops-per-second",
  numberEnv("UNBLOCK_BENCH_MIN_STORAGE_OPS", 50),
  "--min-read-ops-per-second",
  numberEnv("UNBLOCK_BENCH_MIN_READ_OPS", 20),
  "--min-connector-ops-per-second",
  numberEnv("UNBLOCK_BENCH_MIN_CONNECTOR_OPS", 20),
];

if (postgresUrl) {
  matrixArgs.push("--postgres-url", postgresUrl);
}
if (hostedPostgresUrl) {
  matrixArgs.push("--hosted-postgres-url", hostedPostgresUrl);
}
if (process.env.UNBLOCK_BENCH_HOSTED_TENANT_ID) {
  matrixArgs.push("--hosted-tenant-id", process.env.UNBLOCK_BENCH_HOSTED_TENANT_ID);
}

const matrix = await runJson("node", matrixArgs);
const regressions = await compareBaseline(matrix);
const summary = renderMarkdownSummary(matrix, regressions);

await writeFile(resolve(artifactsDir, "benchmark-gates.json"), `${JSON.stringify(matrix, null, 2)}\n`);
await writeFile(resolve(artifactsDir, "benchmark-gates.md"), summary);
process.stdout.write(summary);

if (!matrix.ok || regressions.length > 0) {
  process.exitCode = 1;
}

async function runJson(command, args) {
  const result = await run(command, args);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Expected JSON output from ${command} ${args.join(" ")}: ${error instanceof Error ? error.message : String(error)}\n${result.stdout}`);
  }
}

async function run(command, args) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args.map(String), {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}\n${stderr || stdout}`));
    });
  });
}

async function compareBaseline(matrix) {
  if (!existsSync(baselinePath)) {
    return [];
  }
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const baselineCases = new Map((baseline.cases ?? [])
    .filter((item) => item?.report?.totals?.opsPerSecond)
    .map((item) => [`${item.mode}.${item.scenario}`, item]));
  const regressions = [];
  for (const current of matrix.cases ?? []) {
    if (current.skipped || current.error || !current.report?.totals?.opsPerSecond) {
      continue;
    }
    const baselineCase = baselineCases.get(`${current.mode}.${current.scenario}`);
    const baselineOps = baselineCase?.report?.totals?.opsPerSecond;
    if (!baselineOps) {
      continue;
    }
    const currentOps = current.report.totals.opsPerSecond;
    const ratio = currentOps / baselineOps;
    if (ratio < minimumRegressionRatio) {
      regressions.push({
        mode: current.mode,
        scenario: current.scenario,
        currentOps,
        baselineOps,
        ratio,
      });
    }
  }
  return regressions;
}

function renderMarkdownSummary(matrix, regressions) {
  const lines = [
    "# Benchmark Gates",
    "",
    `Run id: \`${matrix.runId ?? runId}\``,
    `Overall: **${matrix.ok && regressions.length === 0 ? "pass" : "fail"}**`,
    "",
    "| Mode | Scenario | Status | Ops/s | Details |",
    "| --- | --- | ---: | ---: | --- |",
  ];
  for (const item of matrix.cases ?? []) {
    if (item.skipped) {
      lines.push(`| ${item.mode} | ${item.scenario} | skipped |  | ${escapeCell(item.skipReason ?? "")} |`);
      continue;
    }
    if (item.error) {
      lines.push(`| ${item.mode} | ${item.scenario} | failed |  | ${escapeCell(item.error)} |`);
      continue;
    }
    const ok = item.report?.ok === true;
    const ops = item.report?.totals?.opsPerSecond;
    lines.push(`| ${item.mode} | ${item.scenario} | ${ok ? "pass" : "failed"} | ${ops ?? ""} | ${escapeCell(caseDetails(item.report))} |`);
  }
  if (regressions.length > 0) {
    lines.push("", "## Regressions", "");
    for (const regression of regressions) {
      lines.push(`- ${regression.mode}.${regression.scenario}: ${regression.currentOps} ops/s is ${Math.round(regression.ratio * 100)}% of baseline ${regression.baselineOps} ops/s`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function caseDetails(report) {
  if (!report) return "";
  if (report.unsupportedReason) return report.unsupportedReason;
  const phases = report.phases?.length ?? 0;
  const elapsed = report.totals?.elapsedMs;
  return `${phases} phases, ${elapsed ?? 0}ms`;
}

function integerEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return String(fallback);
  const parsed = Number.parseInt(value, 10);
  return String(Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback);
}

function numberEnv(name, fallback) {
  return String(numericEnv(name, fallback));
}

function numericEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sanitize(value) {
  return value.trim().replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "BENCH";
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}
