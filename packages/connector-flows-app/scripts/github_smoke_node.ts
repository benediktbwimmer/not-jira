import { runGithubSmoke } from "./github_smoke.ts";

async function main() {
  const args = new Set(process.argv.slice(2));
  const result = await runGithubSmoke(process.env, {
    allowMissingEnv: args.has("--allow-missing-env"),
    cleanup: !args.has("--no-cleanup"),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok && !(result.skipped && args.has("--allow-missing-env"))) {
    process.exit(result.skipped ? 2 : 1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
