import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { nowIso } from "./types.js";
import type { InboxEvent, OutboxEvent } from "./types.js";

export const connectorProviderSchema = z.enum(["github", "linear", "jira", "asana", "trello", "mock"]);
export type ConnectorProvider = z.infer<typeof connectorProviderSchema>;

export const connectorLocalKindSchema = z.enum(["task", "comment", "tag", "track", "instruction", "project"]);
export type ConnectorLocalKind = z.infer<typeof connectorLocalKindSchema>;

export const connectorExternalKindSchema = z.enum(["issue", "comment", "label", "project", "user", "repository"]);
export type ConnectorExternalKind = z.infer<typeof connectorExternalKindSchema>;

export const connectorEventKindSchema = z.enum([
  "connector.outbound.sync_requested",
  "connector.outbound.local_changed",
  "connector.inbound.external_changed",
  "connector.inbound.task_upserted",
  "connector.inbound.task_archived",
  "connector.inbound.comment_created",
  "connector.reconciliation.requested",
  "connector.reconciliation.completed",
  "connector.cursor.updated",
  "connector.dead_letter.created",
  "connector.operator_review.requested"
]);
export type ConnectorEventKind = z.infer<typeof connectorEventKindSchema>;

export const connectorEventScopeSchema = z.object({
  tenantId: z.string().min(1),
  projectId: z.string().min(1),
  connectionId: z.string().min(1),
  provider: connectorProviderSchema
});
export type ConnectorEventScope = z.infer<typeof connectorEventScopeSchema>;

export const connectorExternalRefSchema = z.object({
  system: z.string().min(1),
  kind: connectorExternalKindSchema,
  id: z.string().min(1),
  url: z.string().url().optional()
});
export type ConnectorExternalRef = z.infer<typeof connectorExternalRefSchema>;

export const connectorLocalRefSchema = z.object({
  kind: connectorLocalKindSchema,
  id: z.string().min(1)
});
export type ConnectorLocalRef = z.infer<typeof connectorLocalRefSchema>;

export const connectorCursorSchema = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
  observedAt: z.string().min(1)
});
export type ConnectorCursor = z.infer<typeof connectorCursorSchema>;

export const connectorErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean().default(false),
  details: z.record(z.string(), z.unknown()).default({})
});
export type ConnectorError = z.infer<typeof connectorErrorSchema>;

export const connectorTaskPayloadSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  lifecycle: z.enum(["open", "started", "finished"]).default("open"),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).default(2),
  sourceUrl: z.string().url().optional()
});
export type ConnectorTaskPayload = z.infer<typeof connectorTaskPayloadSchema>;

export const connectorCommentPayloadSchema = z.object({
  taskId: z.string().min(1),
  body: z.string().min(1),
  author: z.string().min(1).optional()
});
export type ConnectorCommentPayload = z.infer<typeof connectorCommentPayloadSchema>;

export const connectorEventSchema = z.object({
  id: z.string().min(1),
  kind: connectorEventKindSchema,
  scope: connectorEventScopeSchema,
  correlationId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  flowRunId: z.string().min(1).optional(),
  local: connectorLocalRefSchema.optional(),
  external: connectorExternalRefSchema.optional(),
  cursor: connectorCursorSchema.optional(),
  mapping: z.record(z.string(), z.unknown()).optional(),
  task: connectorTaskPayloadSchema.optional(),
  comment: connectorCommentPayloadSchema.optional(),
  error: connectorErrorSchema.optional(),
  evidence: z.record(z.string(), z.unknown()).default({}),
  occurredAt: z.string().min(1)
});
export type ConnectorEvent = z.infer<typeof connectorEventSchema>;

export const connectorFlowTriggerSchema = z.object({
  event: connectorEventSchema,
  outboxEventId: z.string().min(1).optional(),
  attempt: z.number().int().min(0).default(0)
});
export type ConnectorFlowTrigger = z.infer<typeof connectorFlowTriggerSchema>;

export function connectorEvent(input: Omit<ConnectorEvent, "id" | "correlationId" | "idempotencyKey" | "occurredAt"> & {
  id?: string | undefined;
  correlationId?: string | undefined;
  idempotencyKey?: string | undefined;
  occurredAt?: string | undefined;
}): ConnectorEvent {
  const base = {
    ...input,
    id: input.id ?? randomUUID(),
    occurredAt: input.occurredAt ?? nowIso()
  };
  return connectorEventSchema.parse({
    ...base,
    correlationId: input.correlationId ?? connectorCorrelationId(base),
    idempotencyKey: input.idempotencyKey ?? connectorIdempotencyKey(base)
  });
}

export function connectorCorrelationId(input: Pick<ConnectorEvent, "scope"> & Partial<Pick<ConnectorEvent, "local" | "external">>): string {
  if (input.local) {
    return `${input.scope.tenantId}:${input.scope.projectId}:local:${input.local.kind}:${input.local.id}`;
  }
  if (input.external) {
    return `${input.scope.tenantId}:${input.scope.projectId}:external:${input.external.system}:${input.external.kind}:${input.external.id}`;
  }
  return `${input.scope.tenantId}:${input.scope.projectId}:connection:${input.scope.connectionId}`;
}

export function connectorIdempotencyKey(input: Pick<ConnectorEvent, "kind" | "scope"> & Partial<Pick<ConnectorEvent, "local" | "external" | "cursor" | "occurredAt">>): string {
  const hash = createHash("sha256").update(JSON.stringify({
    kind: input.kind,
    scope: input.scope,
    local: input.local ?? null,
    external: input.external ?? null,
    cursor: input.cursor ?? null,
    occurredAt: input.occurredAt ?? null
  })).digest("hex").slice(0, 24);
  return `${input.scope.tenantId}:${input.scope.projectId}:${input.scope.connectionId}:${input.kind}:${hash}`;
}

export function connectorEventFromOutbox(event: OutboxEvent): ConnectorEvent {
  return connectorEventSchema.parse(event.payload);
}

export function connectorTriggerFromOutbox(event: OutboxEvent): ConnectorFlowTrigger {
  return connectorFlowTriggerSchema.parse({
    event: connectorEventFromOutbox(event),
    outboxEventId: event.id,
    attempt: event.attemptCount
  });
}

export function outboxEventForConnector(event: ConnectorEvent, options: {
  projectId?: string | null | undefined;
  subjectType?: string | undefined;
  subjectId?: string | null | undefined;
  availableAt?: string | undefined;
} = {}): OutboxEvent {
  const now = nowIso();
  return {
    projectId: options.projectId ?? event.scope.projectId,
    id: randomUUID(),
    eventType: event.kind,
    subjectType: options.subjectType ?? event.local?.kind ?? "connector",
    subjectId: options.subjectId ?? event.local?.id ?? event.external?.id ?? event.scope.connectionId,
    payload: event,
    idempotencyKey: event.idempotencyKey,
    status: "pending",
    attemptCount: 0,
    availableAt: options.availableAt ?? now,
    createdAt: now,
    claimedAt: null,
    processedAt: null,
    error: null,
    evidence: {}
  };
}

export function inboxEventForConnector(event: ConnectorEvent, source = "prism-flows"): InboxEvent {
  return {
    projectId: event.scope.projectId,
    id: randomUUID(),
    source,
    externalEventId: event.idempotencyKey,
    eventType: event.kind,
    payload: event,
    status: "received",
    appliedAt: null,
    createdAt: nowIso(),
    error: null,
    evidence: {}
  };
}
