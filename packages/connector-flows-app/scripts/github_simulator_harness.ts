import {
  type GithubE2EResult,
  runGithubE2E,
  type SmokeStep,
} from "./github_smoke.ts";
import { startGitHubSimulator } from "./github_simulator.ts";
import {
  startLocalPrismFlowsRuntime,
  stopLocalPrismFlowsRuntime,
} from "../../../../prism-new3/packages/prism-flows/local-runtime.ts";

type Env = Record<string, string | undefined>;

export type HarnessMode =
  | "e2e"
  | "benchmark-reconcile"
  | "benchmark-webhook";

export interface HarnessOptions {
  mode: HarnessMode;
  issueCount: number;
  cleanup: boolean;
  timeoutMs: number;
  tenantId: string;
  projectId: string;
  connectionId: string;
  repository: string;
  prismProjectId: string;
  flowExecutorProcesses: number;
  flowExecutorConcurrency: number;
  schedulerIntervalMs: number;
  issueCreateConcurrency: number;
}

export interface HarnessResult {
  ok: boolean;
  mode: HarnessMode;
  steps: SmokeStep[];
  e2e?: GithubE2EResult;
  benchmark?: {
    issueCount: number;
    elapsedMs: number;
    throughputPerSecond: number;
    taskCount: number;
    taskCreatedSpanMs?: number | null;
    inboxEventCount?: number;
    inboxEventsWithMapping?: number;
    connectorMappingCount?: number;
    hostedAuditCount?: number;
    webhookDeliveries?: {
      total: number;
      ok: number;
      failed: number;
    };
  };
  diagnostics?: string[];
}

const DEFAULT_TIMEOUT_MS = 120_000;
const WEBHOOK_SECRET = "github-simulator-webhook-secret";
const HOSTED_SECRET_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export function parseHarnessOptions(
  args: string[] = [],
  env: Env = Deno.env.toObject(),
): HarnessOptions {
  const flags = parseFlags(args);
  const mode = flagValue(flags, "mode") ??
    (flags.has("benchmark") ? "benchmark-reconcile" : "e2e");
  if (!isHarnessMode(mode)) {
    throw new Error(
      `Unsupported mode ${mode}. Expected e2e, benchmark-reconcile, or benchmark-webhook.`,
    );
  }
  return {
    mode,
    issueCount: positiveInteger(
      flagValue(flags, "issues") ?? env.UNBLOCK_SIM_ISSUES,
      1_000,
    ),
    cleanup: !flags.has("no-cleanup"),
    timeoutMs: positiveInteger(
      flagValue(flags, "timeout-ms") ?? env.UNBLOCK_SIM_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
    tenantId: flagValue(flags, "tenant") ?? env.UNBLOCK_TENANT_ID ??
      "ORG_UNBLOCK_SIM",
    projectId: flagValue(flags, "project") ?? env.UNBLOCK_PROJECT_ID ??
      `SIM_${Date.now()}`,
    connectionId: flagValue(flags, "connection") ??
      env.UNBLOCK_GITHUB_CONNECTION_ID ?? "github-main",
    repository: flagValue(flags, "repo") ?? env.GITHUB_REPOSITORY ??
      "simulated/unblock",
    prismProjectId: flagValue(flags, "prism-project") ??
      env.PRISM_FLOWS_PROJECT_ID ?? "unblock-flows",
    flowExecutorProcesses: positiveInteger(
      flagValue(flags, "flow-executor-processes") ??
        env.PRISM_FLOWS_EXECUTOR_PROCESSES,
      1,
    ),
    flowExecutorConcurrency: positiveInteger(
      flagValue(flags, "flow-executor-concurrency") ??
        env.PRISM_FLOWS_EXECUTOR_CONCURRENCY,
      256,
    ),
    schedulerIntervalMs: positiveInteger(
      flagValue(flags, "scheduler-interval-ms") ??
        env.PRISM_FLOWS_SCHEDULER_INTERVAL_MS,
      1_000,
    ),
    issueCreateConcurrency: positiveInteger(
      flagValue(flags, "issue-create-concurrency") ??
        env.UNBLOCK_SIM_ISSUE_CREATE_CONCURRENCY,
      32,
    ),
  };
}

export function missingHarnessEnv(env: Env = Deno.env.toObject()): string[] {
  const missing = [];
  if (!postgresUrlForUnblock(env)) {
    missing.push("UNBLOCK_E2E_POSTGRES_URL or UNBLOCK_POSTGRES_URL");
  }
  if (!postgresUrlForPrism(env)) {
    missing.push("PRISM_POSTGRES_URL or UNBLOCK_E2E_POSTGRES_URL");
  }
  return missing;
}

export async function runGithubSimulatorHarness(
  env: Env = Deno.env.toObject(),
  options: HarnessOptions = parseHarnessOptions([], env),
): Promise<HarnessResult> {
  const missing = missingHarnessEnv(env);
  if (missing.length > 0) {
    return {
      ok: false,
      mode: options.mode,
      steps: [{
        name: "preflight",
        ok: false,
        ms: 0,
        detail: `Missing required environment: ${missing.join(", ")}`,
      }],
      diagnostics: missing,
    };
  }

  const steps: SmokeStep[] = [];
  const runtimeDir = await Deno.makeTempDir({
    prefix: "unblock-github-sim-",
  });
  const configPath = `${runtimeDir}/unblock.config.json`;
  const unblockPort = await freePort();
  const prismPort = await freePort();
  const ingressPort = await freePort();
  const simulatorPort = await freePort();
  const unblockUrl = `http://127.0.0.1:${unblockPort}`;
  const prismEndpoint = `http://127.0.0.1:${prismPort}`;
  const ingressUrl = `http://127.0.0.1:${ingressPort}`;
  const [owner, repo] = parseRepository(options.repository);
  const simulator = await startGitHubSimulator({
    port: simulatorPort,
    rateLimit: {
      primaryLimit: 1_000_000,
      secondaryLimit: 1_000_000,
      contentLimit: 1_000_000,
    },
  });
  let unblock: ManagedProcess | undefined;

  const originalEnv = snapshotEnv([
    "UNBLOCK_HOSTED_API_URL",
    "UNBLOCK_HOSTED_API_TOKEN",
    "UNBLOCK_HOSTED_AUTH_MODE",
    "UNBLOCK_HOSTED_SECRET_KEY",
    "UNBLOCK_HOSTED_SECRET_KEY_ID",
    "UNBLOCK_TRUSTED_PRINCIPAL_ID",
    "UNBLOCK_TRUSTED_ORGANIZATION_ID",
    "UNBLOCK_TRUSTED_ROLES",
    "UNBLOCK_TRUSTED_PERMISSIONS",
    "UNBLOCK_TRUSTED_SESSION_ID",
    "UNBLOCK_POSTGRES_URL",
    "UNBLOCK_BACKEND",
    "UNBLOCK_CONFIG",
    "UNBLOCK_STRUCTURED_LOGS",
    "GITHUB_API_BASE_URL",
    "GITHUB_INSTALLATION_TOKEN",
    "PRISM_WEBHOOK_SECRET",
  ]);

  try {
    await Deno.writeTextFile(
      configPath,
      `${
        JSON.stringify(
          {
            identity: { machine: "sim-harness", actor: "codex-e" },
            storage: {
              mode: "hosted",
              postgresUrl: postgresUrlForUnblock(env),
            },
          },
          null,
          2,
        )
      }\n`,
    );

    const commonEnv = {
      UNBLOCK_BACKEND: "hosted",
      UNBLOCK_POSTGRES_URL: postgresUrlForUnblock(env)!,
      UNBLOCK_HOSTED_API_URL: unblockUrl,
      UNBLOCK_HOSTED_API_TOKEN: "sim-unblock-token",
      UNBLOCK_HOSTED_AUTH_MODE: "trusted-headers",
      UNBLOCK_HOSTED_SECRET_KEY: HOSTED_SECRET_KEY,
      UNBLOCK_HOSTED_SECRET_KEY_ID: "sim",
      UNBLOCK_TRUSTED_PRINCIPAL_ID: "codex-e",
      UNBLOCK_TRUSTED_ORGANIZATION_ID: options.tenantId,
      UNBLOCK_TRUSTED_ROLES: "owner",
      UNBLOCK_TRUSTED_PERMISSIONS: "",
      UNBLOCK_TRUSTED_SESSION_ID: "sim-harness",
      UNBLOCK_CONFIG: configPath,
      UNBLOCK_STRUCTURED_LOGS: "false",
      UNBLOCK_RATE_LIMIT_MAX: "1000000",
      GITHUB_API_BASE_URL: simulator.url,
      GITHUB_INSTALLATION_TOKEN: "sim-installation-token",
      PRISM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    };
    setEnv(commonEnv);

    unblock = await timed(steps, "unblock.start", async () => {
      const child = startManagedProcess({
        command: "npm",
        args: ["run", "dev", "-w", "@unblock/server"],
        cwd: repoRoot(),
        env: {
          ...commonEnv,
          PORT: String(unblockPort),
          UNBLOCK_API_PORT: String(unblockPort),
        },
      });
      await waitForHttp(`${unblockUrl}/api/health`, options.timeoutMs, child);
      return child;
    });

    await timed(steps, "unblock.configure", () =>
      configureUnblock({
        baseUrl: unblockUrl,
        tenantId: options.tenantId,
        projectId: options.projectId,
        connectionId: options.connectionId,
        owner,
        repo,
      }));

    const metadataJson = JSON.stringify({
      tenantId: options.tenantId,
      projectId: options.projectId,
      connectionId: options.connectionId,
      webhookScope: {
        tenantId: options.tenantId,
        projectId: options.projectId,
        connectionId: options.connectionId,
      },
      schedulePayload: {
        tenantId: options.tenantId,
        projectId: options.projectId,
        connectionId: options.connectionId,
        reason: "simulator-scheduled-reconciliation",
      },
      scheduleOverrides: {
        "github-issues-reconcile": {
          schedule: "* * * * *",
          payload: { reason: "simulator-scheduled-reconciliation" },
        },
      },
    });

    const runtime = await timed(steps, "prism.start", async () => {
      const result = await startLocalPrismFlowsRuntime({
        storageBackend: "postgres",
        postgresUrl: postgresUrlForPrism(env)!,
        bind: `127.0.0.1:${prismPort}`,
        outDir: runtimeDir,
        entrypoint: new URL("../prism.flow.ts", import.meta.url),
        projectId: options.prismProjectId,
        prismBin: prismBinary("prism"),
        executorBin: prismBinary("prism-runtime-v2-executor"),
        executorProcesses: options.flowExecutorProcesses,
        executorConcurrency: options.flowExecutorConcurrency,
        webhookBind: `127.0.0.1:${ingressPort}`,
        metadataJson,
      });
      if (!result.ok || !result.runtimePlan) {
        throw new Error(
          `Prism Flow runtime failed to start: ${
            result.diagnostics.join("\n")
          }`,
        );
      }
      await waitForTcp("127.0.0.1", prismPort, options.timeoutMs);
      return result;
    });

    await timed(steps, "prism.ingress.start", async () => {
      await waitForHttp(`${ingressUrl}/healthz`, options.timeoutMs);
    });

    const smokeEnv: Env = {
      UNBLOCK_HOSTED_API_URL: unblockUrl,
      UNBLOCK_HOSTED_AUTH_MODE: "trusted-headers",
      UNBLOCK_E2E_POSTGRES_URL: postgresUrlForUnblock(env)!,
      UNBLOCK_TRUSTED_PRINCIPAL_ID: "codex-e",
      UNBLOCK_TRUSTED_ORGANIZATION_ID: options.tenantId,
      UNBLOCK_TRUSTED_ROLES: "owner",
      UNBLOCK_TENANT_ID: options.tenantId,
      UNBLOCK_PROJECT_ID: options.projectId,
      UNBLOCK_GITHUB_CONNECTION_ID: options.connectionId,
      PRISM_RUNTIME_ENDPOINT: prismEndpoint,
      PRISM_FLOWS_PROJECT_ID: options.prismProjectId,
      GITHUB_REPOSITORY: options.repository,
      GITHUB_TOKEN: "sim-runner-token",
      GITHUB_INSTALLATION_TOKEN: "sim-installation-token",
      GITHUB_API_BASE_URL: simulator.url,
      UNBLOCK_SMOKE_GITHUB_WEBHOOK: "1",
      UNBLOCK_SMOKE_GITHUB_WEBHOOK_URL: `${ingressUrl}/webhooks/github/issues`,
      UNBLOCK_SMOKE_GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      UNBLOCK_SMOKE_TIMEOUT_MS: String(options.timeoutMs),
    };

    if (options.mode === "e2e") {
      const e2e = await timed(
        steps,
        "github.simulator.e2e",
        () => runGithubE2E(smokeEnv, { cleanup: options.cleanup }),
      );
      steps.push(...e2e.steps.map((step) => ({
        ...step,
        name: `github.e2e.${step.name}`,
      })));
      return { ok: e2e.ok, mode: options.mode, steps, e2e };
    }

    const benchmark = options.mode === "benchmark-reconcile"
      ? await runReconcileBenchmark({
        env: smokeEnv,
        steps,
        issueCount: options.issueCount,
        owner,
        repo,
        simulatorUrl: simulator.url,
        timeoutMs: options.timeoutMs,
      })
      : await runWebhookBenchmark({
        env: smokeEnv,
        steps,
        issueCount: options.issueCount,
        owner,
        repo,
        simulator,
        timeoutMs: options.timeoutMs,
        issueCreateConcurrency: options.issueCreateConcurrency,
      });
    return { ok: true, mode: options.mode, steps, benchmark };
  } finally {
    await stopLocalPrismFlowsRuntime({ outDir: runtimeDir }).catch(() => {});
    await unblock?.stop();
    await simulator.close();
    restoreEnv(originalEnv);
    if (options.cleanup) {
      await Deno.remove(runtimeDir, { recursive: true }).catch(() => {});
    }
  }
}

async function runReconcileBenchmark(input: {
  env: Env;
  steps: SmokeStep[];
  issueCount: number;
  owner: string;
  repo: string;
  simulatorUrl: string;
  timeoutMs: number;
}) {
  await timed(
    input.steps,
    "github.simulator.seed",
    () =>
      simulatorJson(input.simulatorUrl, "/_sim/seed", {
        method: "POST",
        body: {
          repository: `${input.owner}/${input.repo}`,
          count: input.issueCount,
          titlePrefix: "[sim-reconcile]",
          body: "Seeded by the Unblock GitHub simulator harness.",
        },
      }),
  );
  const started = performance.now();
  await timed(
    input.steps,
    "prism.github.reconcile_flow",
    () =>
      startReconcileFlow(input.env, {
        cursor: "1970-01-01T00:00:00.000Z",
        reason: "simulator-benchmark-reconcile",
      }),
  );
  const taskCount = await timed(
    input.steps,
    "unblock.tasks.wait",
    () => waitForTaskCount(input.env, input.issueCount, input.timeoutMs),
  );
  const diagnostics = await collectBenchmarkDiagnostics(input.env).catch(() =>
    undefined
  );
  const elapsedMs = Math.round(performance.now() - started);
  return {
    issueCount: input.issueCount,
    elapsedMs,
    throughputPerSecond: perSecond(taskCount, elapsedMs),
    taskCount,
    ...diagnostics,
  };
}

async function runWebhookBenchmark(input: {
  env: Env;
  steps: SmokeStep[];
  issueCount: number;
  owner: string;
  repo: string;
  simulator: Awaited<ReturnType<typeof startGitHubSimulator>>;
  timeoutMs: number;
  issueCreateConcurrency: number;
}) {
  await timed(input.steps, "github.webhook.create", () =>
    simulatorJson(
      input.simulator.url,
      `/repos/${encodeURIComponent(input.owner)}/${
        encodeURIComponent(input.repo)
      }/hooks`,
      {
        method: "POST",
        body: {
          name: "web",
          active: true,
          events: ["issues"],
          config: {
            url: input.env.UNBLOCK_SMOKE_GITHUB_WEBHOOK_URL,
            content_type: "json",
            secret: WEBHOOK_SECRET,
          },
        },
      },
    ));
  const started = performance.now();
  await timed(input.steps, "github.issues.create_many", async () => {
    await mapConcurrent(
      Array.from({ length: input.issueCount }, (_, index) => index),
      input.issueCreateConcurrency,
      async (index) => {
        await simulatorJson(
          input.simulator.url,
          `/repos/${encodeURIComponent(input.owner)}/${
            encodeURIComponent(input.repo)
          }/issues`,
          {
            method: "POST",
            body: {
              title: `[sim-webhook] ${index + 1}`,
              body: "Created by the Unblock GitHub simulator harness.",
            },
          },
        );
      },
    );
  });
  const webhookDeliveries = await timed(
    input.steps,
    "github.webhooks.drain",
    async () => {
      await input.simulator.drainWebhooks();
      const deliveries = input.simulator.state.deliveries;
      const failed = deliveries.filter((delivery) => !delivery.ok);
      if (failed.length > 0) {
        throw new Error(
          `${failed.length}/${deliveries.length} webhook deliveries failed: ${
            failed
              .slice(0, 3)
              .map((delivery) =>
                `${delivery.status ?? "no-status"} ${
                  delivery.error ?? delivery.url
                }`
              )
              .join("; ")
          }`,
        );
      }
      return {
        total: deliveries.length,
        ok: deliveries.filter((delivery) => delivery.ok).length,
        failed: failed.length,
      };
    },
  );
  const taskCount = await timed(
    input.steps,
    "unblock.tasks.wait",
    () => waitForTaskCount(input.env, input.issueCount, input.timeoutMs),
  );
  const diagnostics = await collectBenchmarkDiagnostics(input.env).catch(() =>
    undefined
  );
  const elapsedMs = Math.round(performance.now() - started);
  return {
    issueCount: input.issueCount,
    elapsedMs,
    throughputPerSecond: perSecond(taskCount, elapsedMs),
    taskCount,
    ...diagnostics,
    webhookDeliveries,
  };
}

async function configureUnblock(input: {
  baseUrl: string;
  tenantId: string;
  projectId: string;
  connectionId: string;
  owner: string;
  repo: string;
}) {
  const headers = trustedHeaders(input.tenantId);
  await unblockJson(input.baseUrl, headers, "/api/projects", {
    method: "POST",
    body: { id: input.projectId, name: input.projectId },
  });
  const privateKey = await unblockJson(
    input.baseUrl,
    headers,
    `/api/secrets?projectId=${encodeURIComponent(input.projectId)}`,
    {
      method: "POST",
      body: {
        name: `github-private-key-${input.projectId}`,
        purpose: "github.private_key",
        plaintext: "sim-private-key",
      },
    },
  );
  const webhookSecret = await unblockJson(
    input.baseUrl,
    headers,
    `/api/secrets?projectId=${encodeURIComponent(input.projectId)}`,
    {
      method: "POST",
      body: {
        name: `github-webhook-secret-${input.projectId}`,
        purpose: "github.webhook_secret",
        plaintext: WEBHOOK_SECRET,
      },
    },
  );
  await unblockJson(
    input.baseUrl,
    headers,
    "/api/connectors/github/connections",
    {
      method: "POST",
      body: {
        projectId: input.projectId,
        connectionId: input.connectionId,
        displayName: `GitHub ${input.owner}/${input.repo}`,
        appId: "sim-app",
        installationId: "sim-installation",
        repositoryOwner: input.owner,
        repositoryName: input.repo,
        privateKeySecretId: privateKey.id,
        webhookSecretId: webhookSecret.id,
        syncDirection: "bidirectional",
        conflictPolicy: "operator_review",
      },
    },
  );
}

async function startReconcileFlow(
  env: Env,
  input: { cursor: string; reason: string },
) {
  const { DenoGrpcPrismFlowClient } = await import(
    "../../../../prism-new3/packages/prism-flows/execution-deno.ts"
  );
  const tenantId = required(env, "UNBLOCK_TENANT_ID");
  const projectId = required(env, "UNBLOCK_PROJECT_ID");
  const connectionId = required(env, "UNBLOCK_GITHUB_CONNECTION_ID");
  const client = new DenoGrpcPrismFlowClient({
    endpoint: required(env, "PRISM_RUNTIME_ENDPOINT"),
    defaultProjectId: required(env, "PRISM_FLOWS_PROJECT_ID"),
    timeoutMs: Number(env.UNBLOCK_SMOKE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
  });
  try {
    return await client.startFlow({
      projectId: required(env, "PRISM_FLOWS_PROJECT_ID"),
      appId: "flows",
      flowId: "github-issues-reconcile",
      workflowId: "github-issues-reconcile",
      triggerId: "manual",
      flowKey: `${tenantId}:${projectId}:${connectionId}:${input.reason}`,
      idempotencyKey:
        `${tenantId}:${projectId}:${connectionId}:${input.reason}`,
      tenantId,
      unblockProjectId: projectId,
      correlationId: `${tenantId}:${projectId}:${connectionId}:${input.reason}`,
      payload: {
        tenantId,
        projectId,
        connectionId,
        cursor: input.cursor,
        reason: input.reason,
      },
      metadata: {
        tenantId,
        projectId,
        correlationId:
          `${tenantId}:${projectId}:${connectionId}:${input.reason}`,
        idempotencyKey:
          `${tenantId}:${projectId}:${connectionId}:${input.reason}`,
        source: "github_simulator_harness",
      },
      mode: "attach_or_start",
    });
  } finally {
    await client.close?.();
  }
}

async function waitForTaskCount(env: Env, expected: number, timeoutMs: number) {
  const postgresUrl = postgresUrlForUnblock(env);
  if (postgresUrl) {
    return await waitForTaskCountPostgres(env, postgresUrl, expected, timeoutMs)
      .catch(() => waitForTaskCountHttp(env, expected, timeoutMs));
  }
  return await waitForTaskCountHttp(env, expected, timeoutMs);
}

async function waitForTaskCountPostgres(
  env: Env,
  postgresUrl: string,
  expected: number,
  timeoutMs: number,
) {
  const projectId = required(env, "UNBLOCK_PROJECT_ID");
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  const projectLiteral = sqlLiteral(projectId);
  while (Date.now() <= deadline) {
    lastCount = await psqlInt(
      postgresUrl,
      `select count(*)::int from tasks where project_id = ${projectLiteral} and id like 'GH-%'`,
    );
    if (lastCount >= expected) return lastCount;
    await delay(50);
  }
  throw new Error(
    `Timed out waiting for ${expected} GitHub tasks; observed ${lastCount}.`,
  );
}

async function waitForTaskCountHttp(
  env: Env,
  expected: number,
  timeoutMs: number,
) {
  const baseUrl = required(env, "UNBLOCK_HOSTED_API_URL");
  const projectId = required(env, "UNBLOCK_PROJECT_ID");
  const tenantId = required(env, "UNBLOCK_TENANT_ID");
  const headers = trustedHeaders(tenantId);
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  while (Date.now() <= deadline) {
    const tasks = await unblockJson(
      baseUrl,
      headers,
      `/api/tasks?projectId=${
        encodeURIComponent(projectId)
      }&includeFinished=true&includeArchived=true`,
    );
    lastCount = Array.isArray(tasks)
      ? tasks.filter((task) => String(task.id ?? "").startsWith("GH-")).length
      : 0;
    if (lastCount >= expected) return lastCount;
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for ${expected} GitHub tasks; observed ${lastCount}.`,
  );
}

async function collectBenchmarkDiagnostics(env: Env) {
  const postgresUrl = postgresUrlForUnblock(env);
  if (!postgresUrl) return undefined;
  const projectId = required(env, "UNBLOCK_PROJECT_ID");
  const projectLiteral = sqlLiteral(projectId);
  const rows = await psqlRows(
    postgresUrl,
    `
      select 'task_count', count(*)::text from tasks where project_id = ${projectLiteral} and id like 'GH-%'
      union all
      select 'task_span_ms', coalesce(round(extract(epoch from max(created_at)-min(created_at))*1000)::bigint, 0)::text from tasks where project_id = ${projectLiteral} and id like 'GH-%'
      union all
      select 'inbox_event_count', count(*)::text from inbox_events where project_id = ${projectLiteral}
      union all
      select 'inbox_events_with_mapping', (count(*) filter (where payload_json ? 'mapping'))::text from inbox_events where project_id = ${projectLiteral}
      union all
      select 'connector_mapping_count', count(*)::text from connector_external_mappings where project_id = ${projectLiteral}
      union all
      select 'hosted_audit_count', count(*)::text from hosted_audit_events where project_id = ${projectLiteral}
    `,
  );
  const values = new Map(rows.map((row) => {
    const [key, value] = row.split("|", 2);
    return [key, Number(value)];
  }));
  return {
    taskCreatedSpanMs: values.get("task_span_ms") ?? null,
    inboxEventCount: values.get("inbox_event_count") ?? 0,
    inboxEventsWithMapping: values.get("inbox_events_with_mapping") ?? 0,
    connectorMappingCount: values.get("connector_mapping_count") ?? 0,
    hostedAuditCount: values.get("hosted_audit_count") ?? 0,
  };
}

async function psqlInt(
  postgresUrl: string,
  sql: string,
): Promise<number> {
  const rows = await psqlRows(postgresUrl, sql);
  const value = Number(rows[0]?.trim() ?? "NaN");
  if (!Number.isFinite(value)) {
    throw new Error(`psql did not return a numeric value: ${rows.join("\n")}`);
  }
  return value;
}

async function psqlRows(
  postgresUrl: string,
  sql: string,
): Promise<string[]> {
  const command = new Deno.Command("psql", {
    args: [
      "-X",
      "-q",
      "-A",
      "-t",
      postgresUrl,
      "-c",
      sql,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr).trim());
  }
  return new TextDecoder()
    .decode(output.stdout)
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean);
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function timed<T>(
  steps: SmokeStep[],
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    const result = await run();
    steps.push({ name, ok: true, ms: Math.round(performance.now() - started) });
    return result;
  } catch (error) {
    steps.push({
      name,
      ok: false,
      ms: Math.round(performance.now() - started),
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function unblockJson(
  baseUrl: string,
  headers: Record<string, string>,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  return await requestJson(`${baseUrl}${path}`, {
    ...init,
    headers,
  });
}

async function simulatorJson(
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  return await requestJson(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: "Bearer sim-runner-token" },
  });
}

async function requestJson(
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> },
) {
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  const body = text.trim() ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return body;
}

function trustedHeaders(tenantId: string): Record<string, string> {
  return {
    "x-unblock-principal-id": "codex-e",
    "x-unblock-workos-organization-id": tenantId,
    "x-unblock-roles": "owner",
  };
}

type ManagedProcess = {
  stop: () => Promise<void>;
  tail: () => string;
};

function startManagedProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}): ManagedProcess {
  const child = new Deno.Command(input.command, {
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const lines: string[] = [];
  drain(child.stdout, lines);
  drain(child.stderr, lines);
  return {
    stop: async () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already exited.
      }
      await child.status.catch(() => ({ success: false }));
    },
    tail: () => lines.slice(-40).join("\n"),
  };
}

async function drain(stream: ReadableStream<Uint8Array>, lines: string[]) {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      lines.push(line);
      if (lines.length > 200) lines.splice(0, lines.length - 200);
    }
  }
}

async function waitForHttp(
  url: string,
  timeoutMs: number,
  process?: ManagedProcess,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      const response = await fetch(url);
      await response.body?.cancel();
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  const suffix = process ? `\n${process.tail()}` : "";
  throw new Error(
    `Timed out waiting for ${url}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }${suffix}`,
  );
}

async function waitForTcp(host: string, port: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      const conn = await Deno.connect({ hostname: host, port });
      conn.close();
      return;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for TCP ${host}:${port}: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function freePort(): Promise<number> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

function setEnv(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    Deno.env.set(key, value);
  }
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of keys) snapshot[key] = Deno.env.get(key);
  return snapshot;
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

function postgresUrlForUnblock(env: Env): string | undefined {
  return env.UNBLOCK_E2E_POSTGRES_URL?.trim() ||
    env.UNBLOCK_POSTGRES_URL?.trim() ||
    env.UNBLOCK_TEST_POSTGRES_URL?.trim();
}

function postgresUrlForPrism(env: Env): string | undefined {
  return env.PRISM_POSTGRES_URL?.trim() ||
    env.UNBLOCK_E2E_PRISM_POSTGRES_URL?.trim() ||
    postgresUrlForUnblock(env);
}

function parseRepository(value: string): [string, string] {
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`repository must use owner/repo format: ${value}`);
  }
  return [parts[0], parts[1]];
}

function parseFlags(args: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=", 2);
    flags.set(key, value ?? true);
  }
  return flags;
}

function flagValue(
  flags: Map<string, string | true>,
  key: string,
): string | undefined {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isHarnessMode(value: string): value is HarnessMode {
  return value === "e2e" || value === "benchmark-reconcile" ||
    value === "benchmark-webhook";
}

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function perSecond(count: number, elapsedMs: number): number {
  return Math.round((count / Math.max(1, elapsedMs)) * 1_000 * 100) / 100;
}

async function mapConcurrent<T>(
  items: T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await run(items[index], index);
    }
  }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function repoRoot(): string {
  return new URL("../../../", import.meta.url).pathname;
}

function prismBinary(name: string): string | undefined {
  const envName = `${name.replaceAll("-", "_").toUpperCase()}_BIN`;
  const explicit = Deno.env.get(envName);
  if (explicit?.trim()) return explicit;
  for (
    const candidate of [
      new URL(
        `../../target/release/${name}`,
        import.meta.resolve(
          "../../../../prism-new3/packages/prism-flows/mod.ts",
        ),
      ).pathname,
      new URL(
        `../../target/debug/${name}`,
        import.meta.resolve(
          "../../../../prism-new3/packages/prism-flows/mod.ts",
        ),
      ).pathname,
    ]
  ) {
    try {
      if (Deno.statSync(candidate).isFile) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

if (import.meta.main) {
  const options = parseHarnessOptions(Deno.args);
  const result = await runGithubSimulatorHarness(Deno.env.toObject(), options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) Deno.exit(1);
}
