import {
  missingHarnessEnv,
  parseHarnessOptions,
  runGithubSimulatorHarness,
} from "../scripts/github_simulator_harness.ts";

Deno.test("GitHub simulator harness reports missing Postgres prerequisites", async () => {
  const result = await runGithubSimulatorHarness(
    {},
    parseHarnessOptions([], {}),
  );
  if (result.ok) {
    throw new Error("harness should not run without Postgres URLs");
  }
  if (
    !result.diagnostics?.some((item) => item.includes("UNBLOCK_POSTGRES_URL"))
  ) {
    throw new Error(
      `missing diagnostics did not mention Unblock Postgres: ${
        JSON.stringify(result)
      }`,
    );
  }
});

Deno.test("GitHub simulator harness parses benchmark options", () => {
  const options = parseHarnessOptions([
    "--mode=benchmark-webhook",
    "--issues=250",
    "--tenant=ORG_TEST",
    "--project=SIM_TEST",
    "--repo=acme/roadmap",
    "--flow-executor-processes=2",
    "--flow-executor-concurrency=64",
    "--issue-create-concurrency=16",
    "--timeout-ms=45000",
  ], {});
  if (options.mode !== "benchmark-webhook") {
    throw new Error("mode parse failed");
  }
  if (options.issueCount !== 250) throw new Error("issue count parse failed");
  if (options.tenantId !== "ORG_TEST") throw new Error("tenant parse failed");
  if (options.projectId !== "SIM_TEST") throw new Error("project parse failed");
  if (options.repository !== "acme/roadmap") {
    throw new Error("repo parse failed");
  }
  if (options.flowExecutorProcesses !== 2) {
    throw new Error("process count parse failed");
  }
  if (options.flowExecutorConcurrency !== 64) {
    throw new Error("concurrency parse failed");
  }
  if (options.issueCreateConcurrency !== 16) {
    throw new Error("issue create concurrency parse failed");
  }
  if (options.timeoutMs !== 45000) throw new Error("timeout parse failed");
});

Deno.test("GitHub simulator harness accepts shared Postgres URL for Unblock and Prism", () => {
  const missing = missingHarnessEnv({
    UNBLOCK_E2E_POSTGRES_URL: "postgres://localhost/unblock_sim",
  });
  if (missing.length !== 0) {
    throw new Error(
      `shared Postgres URL should satisfy harness preflight: ${
        missing.join(", ")
      }`,
    );
  }
});
