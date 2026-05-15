import { connection } from "../../../../prism-new3/packages/prism-flows/mod.ts";

connection("unblock-hosted-api", {
  auth: { kind: "bearer_token", secret: "UNBLOCK_HOSTED_API_TOKEN" },
  baseUrlEnv: "UNBLOCK_HOSTED_API_URL",
  defaultHeaders: { "content-type": "application/json" },
  defaultHeadersEnv: {
    "x-unblock-principal-id": "UNBLOCK_TRUSTED_PRINCIPAL_ID",
    "x-unblock-workos-organization-id": "UNBLOCK_TRUSTED_ORGANIZATION_ID",
    "x-unblock-roles": "UNBLOCK_TRUSTED_ROLES",
    "x-unblock-permissions": "UNBLOCK_TRUSTED_PERMISSIONS",
    "x-unblock-session-id": "UNBLOCK_TRUSTED_SESSION_ID",
  },
  network: {
    allowDomains: ["unblock-hosted.internal", "127.0.0.1", "localhost"],
  },
  rateLimit: { concurrency: 256, requestsPerSecond: 5000 },
  redaction: {
    request: ["authorization", "plaintext", "ciphertext"],
    response: ["ciphertext"],
  },
  labels: { product: "unblock", boundary: "core-api" },
});
