import { randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import {
  identityFromTrustedHeaders,
  identityFromWorkosClaims,
  hostedPermissionForRequest,
  nowIso,
  requireHostedPermission,
  type AppStore,
  type HostedAuditEvent,
  type HostedIdentity,
  type HostedPermission,
  type SubjectType
} from "@unblock/core";

export type HostedAuthMode = "workos-jwt" | "trusted-headers";

export interface HostedRuntimeConfig {
  authMode: HostedAuthMode;
  workosClientId: string;
  workosIssuer: string | string[];
  workosJwksUrl: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  identitySyncTtlMs?: number | undefined;
}

export interface HostedConfigStatus {
  mode: "hosted";
  ready: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  authMode: HostedAuthMode;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  structuredLogs: boolean;
}

export interface HostedRequestContext {
  identity: HostedIdentity;
  requestId: string;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const rateLimitBuckets = new Map<string, { resetAt: number; count: number }>();
const identitySyncCache = new Map<string, { fingerprint: string; expiresAt: number; inFlight?: Promise<void> }>();

export function hostedRuntimeConfig(env: NodeJS.ProcessEnv = process.env): HostedRuntimeConfig {
  const clientId = env.WORKOS_CLIENT_ID?.trim() ?? "";
  const authMode = (env.UNBLOCK_HOSTED_AUTH_MODE?.trim() || "workos-jwt") as HostedAuthMode;
  const issuer = env.WORKOS_ISSUER?.trim();
  return {
    authMode,
    workosClientId: clientId,
    workosIssuer: issuer || ["https://api.workos.com", "https://api.workos.com/"],
    workosJwksUrl: env.WORKOS_JWKS_URL?.trim() || (clientId ? `https://api.workos.com/sso/jwks/${clientId}` : ""),
    rateLimitWindowMs: parsePositiveInteger(env.UNBLOCK_RATE_LIMIT_WINDOW_MS, 60_000),
    rateLimitMax: parsePositiveInteger(env.UNBLOCK_RATE_LIMIT_MAX, 600),
    identitySyncTtlMs: parseNonNegativeInteger(env.UNBLOCK_HOSTED_IDENTITY_SYNC_TTL_MS, 30_000)
  };
}

export function hostedConfigStatus(env: NodeJS.ProcessEnv = process.env): HostedConfigStatus {
  const config = hostedRuntimeConfig(env);
  const checks = [
    {
      name: "storage_mode",
      ok: ["hosted"].includes((env.UNBLOCK_BACKEND ?? env.UNBLOCK_STORAGE_MODE ?? "").trim().toLowerCase()),
      detail: "UNBLOCK_BACKEND or UNBLOCK_STORAGE_MODE must be hosted."
    },
    {
      name: "postgres_url",
      ok: Boolean(env.UNBLOCK_POSTGRES_URL?.trim()),
      detail: "UNBLOCK_POSTGRES_URL must point at the hosted Postgres database."
    },
    {
      name: "workos_client",
      ok: config.authMode === "trusted-headers" || Boolean(config.workosClientId),
      detail: "WORKOS_CLIENT_ID is required for WorkOS JWT verification."
    },
    {
      name: "workos_jwks",
      ok: config.authMode === "trusted-headers" || Boolean(config.workosJwksUrl),
      detail: "WORKOS_JWKS_URL may override the default WorkOS JWKS URL."
    },
    {
      name: "secret_key",
      ok: secretKeyLooksValid(env.UNBLOCK_HOSTED_SECRET_KEY),
      detail: "UNBLOCK_HOSTED_SECRET_KEY must decode to a 32-byte encryption key."
    }
  ];
  return {
    mode: "hosted",
    ready: checks.every((check) => check.ok),
    checks,
    authMode: config.authMode,
    rateLimitWindowMs: config.rateLimitWindowMs,
    rateLimitMax: config.rateLimitMax,
    structuredLogs: env.UNBLOCK_STRUCTURED_LOGS !== "false"
  };
}

export async function resolveHostedIdentity(headers: Headers, config: HostedRuntimeConfig): Promise<HostedIdentity> {
  if (config.authMode === "trusted-headers") {
    return identityFromTrustedHeaders({
      principalId: requiredHeader(headers, "x-unblock-principal-id"),
      organizationId: requiredHeader(headers, "x-unblock-workos-organization-id"),
      sessionId: headers.get("x-unblock-session-id"),
      roles: headers.get("x-unblock-roles"),
      permissions: headers.get("x-unblock-permissions")
    });
  }

  if (!config.workosClientId || !config.workosJwksUrl) {
    throw new Error("Hosted WorkOS JWT auth requires WORKOS_CLIENT_ID.");
  }
  const token = bearerToken(headers.get("authorization"));
  const jwks = cachedJwks(config.workosJwksUrl);
  const verified = await jwtVerify(token, jwks, { issuer: config.workosIssuer });
  return identityFromWorkosClaims(verified.payload as JWTPayload);
}

export async function syncHostedIdentity(store: AppStore, identity: HostedIdentity, ttlMs = 0): Promise<void> {
  const repository = store.hostedIdentity;
  if (!repository) return;
  if (ttlMs <= 0) {
    await repository.sync(identity);
    return;
  }

  const now = Date.now();
  const key = `${identity.tenantId}:${identity.principalId}`;
  const fingerprint = hostedIdentityFingerprint(identity);
  const existing = identitySyncCache.get(key);
  if (existing?.fingerprint === fingerprint) {
    if (existing.expiresAt > now) return;
    if (existing.inFlight) return await existing.inFlight;
  }

  const inFlight = repository.sync(identity)
    .then(() => {
      identitySyncCache.set(key, { fingerprint, expiresAt: Date.now() + ttlMs });
    })
    .catch((error) => {
      identitySyncCache.delete(key);
      throw error;
    });
  identitySyncCache.set(key, { fingerprint, expiresAt: 0, inFlight });
  await inFlight;
}

export async function enforceHostedRequest(
  store: AppStore,
  context: HostedRequestContext,
  method: string,
  path: string,
  projectId: string | null,
  request: Request
): Promise<void> {
  const permission = hostedPermissionForRequest(method, path);
  try {
    requireHostedPermission(context.identity, permission);
    if (shouldAuditAllowedHostedRequest(method, path)) {
      await appendHostedAudit(store, context, {
        projectId,
        eventType: "hosted.request.allowed",
        subjectType: permissionSubject(permission),
        subjectId: projectId,
        message: `Allowed ${method} ${path}`,
        data: { method, path, permission },
        request
      });
    }
  } catch (error) {
    await appendHostedAudit(store, context, {
      projectId,
      eventType: "hosted.request.denied",
      subjectType: permissionSubject(permission),
      subjectId: projectId,
      message: `Denied ${method} ${path}`,
      data: { method, path, permission },
      request
    });
    throw error;
  }
}

export function enforceHostedRateLimit(identity: HostedIdentity, config: HostedRuntimeConfig): { remaining: number; resetAt: number } {
  const now = Date.now();
  const key = `${identity.tenantId}:${identity.principalId}`;
  const existing = rateLimitBuckets.get(key);
  const bucket = existing && existing.resetAt > now ? existing : { resetAt: now + config.rateLimitWindowMs, count: 0 };
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  if (bucket.count > config.rateLimitMax) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    const error = new Error(`Rate limit exceeded. Retry after ${retryAfter}s.`);
    Object.assign(error, { status: 429, retryAfter });
    throw error;
  }
  return { remaining: config.rateLimitMax - bucket.count, resetAt: bucket.resetAt };
}

export async function appendHostedAudit(
  store: AppStore,
  context: HostedRequestContext,
  input: {
    projectId: string | null;
    eventType: string;
    subjectType: SubjectType;
    subjectId: string | null;
    message: string;
    data?: Record<string, unknown> | undefined;
    request: Request;
  }
): Promise<void> {
  const event: HostedAuditEvent = {
    tenantId: context.identity.tenantId,
    projectId: input.projectId,
    id: randomUUID(),
    eventType: input.eventType,
    principalId: context.identity.principalId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    message: input.message,
    data: input.data ?? {},
    requestId: context.requestId,
    ipAddress: clientIp(input.request.headers),
    userAgent: input.request.headers.get("user-agent"),
    createdAt: nowIso()
  };
  await store.hostedAudit?.append(event);
}

export function requestId(headers: Headers): string {
  return headers.get("x-request-id")?.trim() || randomUUID();
}

function cachedJwks(url: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = jwksCache.get(url);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(url));
  jwksCache.set(url, jwks);
  return jwks;
}

function bearerToken(value: string | null): string {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) throw new Error("Hosted requests require a bearer token.");
  return match[1];
}

function requiredHeader(headers: Headers, name: string): string {
  const value = headers.get(name)?.trim();
  if (!value) throw new Error(`Hosted trusted-header auth requires ${name}.`);
  return value;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function hostedIdentityFingerprint(identity: HostedIdentity): string {
  return JSON.stringify({
    organizationId: identity.organizationId,
    roles: [...identity.roles].sort(),
    permissions: [...identity.permissions].sort(),
    issuedBy: identity.issuedBy
  });
}

function secretKeyLooksValid(value: string | undefined): boolean {
  const raw = value?.trim();
  if (!raw) return false;
  const bytes = raw.startsWith("base64:") ? Buffer.from(raw.slice("base64:".length), "base64") : Buffer.from(raw, "hex");
  return bytes.length === 32;
}

function permissionSubject(permission: HostedPermission): SubjectType {
  if (permission.startsWith("tenant:")) return "tenant";
  if (permission.startsWith("connector:")) return "connector";
  return "project";
}

function shouldAuditAllowedHostedRequest(method: string, path: string): boolean {
  if (method.toUpperCase() !== "POST") return true;
  return ![
    "/api/connectors/inbox",
    "/api/connectors/inbox/batch",
    "/api/connectors/github/mappings",
    "/api/connectors/github/mappings/batch"
  ].includes(path);
}

function clientIp(headers: Headers): string | null {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim() || null;
}
