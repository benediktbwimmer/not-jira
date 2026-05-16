import { randomUUID } from "node:crypto";
import { z } from "zod";
import { validation } from "./errors.js";
import { matchMatcherQuery } from "./matcher-query.js";
import type { AppStore, ResponsibilityRepository } from "./store.js";
import {
  nowIso,
  type DelegationRule,
  type DelegationTargetKind,
  type Dependency,
  type ExternalIdentity,
  type ExternalIdentityConfidence,
  type Principal,
  type PrincipalKind,
  type TaskResponsibility,
  type TaskResponsibilityRole,
  type TaskView,
} from "./types.js";

export const principalKindSchema = z.enum(["user", "team", "service_account", "bot"]);
export const externalIdentityKindSchema = z.enum(["user", "team", "bot", "service_account"]);
export const externalIdentityConfidenceSchema = z.enum(["verified", "inferred", "unmapped"]);
export const taskResponsibilityRoleSchema = z.enum(["owner", "reviewer", "watcher"]);
export const delegationTargetKindSchema = z.enum(["track", "actor_pool", "principal"]);

export const principalInputSchema = z.object({
  tenantId: z.string().min(1),
  id: z.string().min(1).optional(),
  kind: principalKindSchema.default("user"),
  displayName: z.string().min(1),
  email: z.string().email().nullable().optional(),
  disabledAt: z.string().min(1).nullable().optional(),
});
export type PrincipalInput = z.input<typeof principalInputSchema>;

export const externalIdentityInputSchema = z.object({
  tenantId: z.string().min(1),
  connectionId: z.string().min(1),
  provider: z.string().min(1),
  externalKind: externalIdentityKindSchema.default("user"),
  externalId: z.string().min(1),
  externalDisplayName: z.string().min(1).nullable().optional(),
  externalEmail: z.string().email().nullable().optional(),
  principalId: z.string().min(1).nullable().optional(),
  confidence: externalIdentityConfidenceSchema.optional(),
});
export type ExternalIdentityInput = z.input<typeof externalIdentityInputSchema>;

export const taskResponsibilityInputSchema = z.object({
  tenantId: z.string().min(1),
  projectId: z.string().min(1),
  taskId: z.string().min(1),
  principalId: z.string().min(1),
  role: taskResponsibilityRoleSchema.default("owner"),
  source: z.enum(["manual", "connector", "delegation"]).default("connector"),
  archivedAt: z.string().min(1).nullable().optional(),
});
export type TaskResponsibilityInput = z.input<typeof taskResponsibilityInputSchema>;

export const delegationRuleInputSchema = z.object({
  tenantId: z.string().min(1),
  projectId: z.string().min(1),
  id: z.string().min(1).optional(),
  principalId: z.string().min(1),
  targetKind: delegationTargetKindSchema,
  targetId: z.string().min(1),
  scopeQuery: z.string().min(1).nullable().optional(),
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
  archivedAt: z.string().min(1).nullable().optional(),
});
export type DelegationRuleInput = z.input<typeof delegationRuleInputSchema>;

export interface ExternalAssigneeResponsibilityInput extends ExternalIdentityInput {
  projectId: string;
  taskId: string;
  role?: TaskResponsibilityRole | undefined;
  source?: TaskResponsibility["source"] | undefined;
}

export interface ExternalAssigneeResponsibilityResult {
  externalIdentity: ExternalIdentity;
  responsibility: TaskResponsibility | null;
  status: "mapped" | "unmapped";
}

export interface TaskDelegationResolutionInput {
  task: TaskView;
  allTasks: TaskView[];
  dependencies: Dependency[];
  responsibilities: TaskResponsibility[];
  rules: DelegationRule[];
}

export interface TaskDelegationResolution {
  responsibility: TaskResponsibility;
  rule: DelegationRule;
  targetKind: DelegationTargetKind;
  targetId: string;
  reason: string;
}

export function createPrincipalRecord(input: PrincipalInput, now = nowIso()): Principal {
  const parsed = principalInputSchema.parse(input);
  return {
    tenantId: parsed.tenantId,
    id: parsed.id ?? randomUUID(),
    kind: parsed.kind,
    displayName: parsed.displayName,
    email: parsed.email ?? null,
    createdAt: now,
    updatedAt: now,
    disabledAt: parsed.disabledAt ?? null,
  };
}

export function createExternalIdentityRecord(
  input: ExternalIdentityInput,
  now = nowIso(),
): ExternalIdentity {
  const parsed = externalIdentityInputSchema.parse(input);
  return {
    tenantId: parsed.tenantId,
    connectionId: parsed.connectionId,
    provider: parsed.provider,
    externalKind: parsed.externalKind,
    externalId: parsed.externalId,
    externalDisplayName: parsed.externalDisplayName ?? null,
    externalEmail: parsed.externalEmail ?? null,
    principalId: parsed.principalId ?? null,
    confidence: parsed.confidence ?? (parsed.principalId ? "verified" : "unmapped"),
    createdAt: now,
    updatedAt: now,
  };
}

export function createTaskResponsibilityRecord(
  input: TaskResponsibilityInput,
  now = nowIso(),
): TaskResponsibility {
  const parsed = taskResponsibilityInputSchema.parse(input);
  return {
    tenantId: parsed.tenantId,
    projectId: parsed.projectId,
    taskId: parsed.taskId,
    principalId: parsed.principalId,
    role: parsed.role,
    source: parsed.source,
    createdAt: now,
    updatedAt: now,
    archivedAt: parsed.archivedAt ?? null,
  };
}

export function createDelegationRuleRecord(
  input: DelegationRuleInput,
  now = nowIso(),
): DelegationRule {
  const parsed = delegationRuleInputSchema.parse(input);
  return {
    tenantId: parsed.tenantId,
    projectId: parsed.projectId,
    id: parsed.id ?? randomUUID(),
    principalId: parsed.principalId,
    targetKind: parsed.targetKind,
    targetId: parsed.targetId,
    scopeQuery: parsed.scopeQuery ?? null,
    priority: parsed.priority,
    enabled: parsed.enabled,
    createdAt: now,
    updatedAt: now,
    archivedAt: parsed.archivedAt ?? null,
  };
}

export async function upsertPrincipal(
  store: AppStore,
  input: PrincipalInput,
): Promise<Principal> {
  const principal = createPrincipalRecord(input);
  await requireResponsibilityRepository(store).upsertPrincipal(principal);
  return principal;
}

export async function upsertExternalIdentity(
  store: AppStore,
  input: ExternalIdentityInput,
): Promise<ExternalIdentity> {
  const repo = requireResponsibilityRepository(store);
  const existing = await repo.getExternalIdentity(
    input.connectionId,
    input.provider,
    input.externalKind ?? "user",
    input.externalId,
  );
  const identity = createExternalIdentityRecord({
    ...input,
    principalId: input.principalId ?? existing?.principalId ?? null,
    confidence: input.confidence ?? existing?.confidence,
  });
  await repo.upsertExternalIdentity(identity);
  return identity;
}

export async function assignExternalAssigneeResponsibility(
  store: AppStore,
  input: ExternalAssigneeResponsibilityInput,
): Promise<ExternalAssigneeResponsibilityResult> {
  const repo = requireResponsibilityRepository(store);
  const existing = await repo.getExternalIdentity(
    input.connectionId,
    input.provider,
    input.externalKind ?? "user",
    input.externalId,
  );
  const principalId = input.principalId ?? existing?.principalId ?? null;
  const identity = createExternalIdentityRecord({
    ...input,
    principalId,
    confidence: input.confidence ?? existing?.confidence ?? (principalId ? "verified" : "unmapped"),
  });
  await repo.upsertExternalIdentity(identity);
  if (!principalId) {
    return { externalIdentity: identity, responsibility: null, status: "unmapped" };
  }
  const responsibility = createTaskResponsibilityRecord({
    tenantId: input.tenantId,
    projectId: input.projectId,
    taskId: input.taskId,
    principalId,
    role: input.role ?? "owner",
    source: input.source ?? "connector",
  });
  await repo.upsertTaskResponsibility(responsibility);
  return { externalIdentity: identity, responsibility, status: "mapped" };
}

export async function upsertDelegationRule(
  store: AppStore,
  input: DelegationRuleInput,
): Promise<DelegationRule> {
  const rule = createDelegationRuleRecord(input);
  await requireResponsibilityRepository(store).upsertDelegationRule(rule);
  return rule;
}

export function resolveTaskDelegations(input: TaskDelegationResolutionInput): TaskDelegationResolution[] {
  const taskSet = input.allTasks.some((task) => task.id === input.task.id)
    ? input.allTasks
    : [input.task, ...input.allTasks];
  const sortedResponsibilities = input.responsibilities
    .filter((responsibility) =>
      responsibility.taskId === input.task.id &&
      responsibility.archivedAt === null
    )
    .sort((left, right) => roleRank(left.role) - roleRank(right.role));
  const sortedRules = input.rules
    .filter((rule) => rule.enabled && rule.archivedAt === null)
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  const resolutions: TaskDelegationResolution[] = [];
  for (const responsibility of sortedResponsibilities) {
    const rule = sortedRules.find((candidate) =>
      candidate.principalId === responsibility.principalId &&
      delegationRuleMatches(candidate, input.task, taskSet, input.dependencies)
    );
    if (!rule) continue;
    resolutions.push({
      responsibility,
      rule,
      targetKind: rule.targetKind,
      targetId: rule.targetId,
      reason: rule.scopeQuery
        ? `Delegation rule ${rule.id} matched ${rule.scopeQuery}.`
        : `Delegation rule ${rule.id} is the default for ${responsibility.principalId}.`,
    });
  }
  return resolutions;
}

function delegationRuleMatches(
  rule: DelegationRule,
  task: TaskView,
  allTasks: TaskView[],
  dependencies: Dependency[],
): boolean {
  if (!rule.scopeQuery) return true;
  return matchMatcherQuery(rule.scopeQuery, allTasks, dependencies)
    .some((match) => match.task.id === task.id);
}

function roleRank(role: TaskResponsibilityRole): number {
  switch (role) {
    case "owner":
      return 0;
    case "reviewer":
      return 1;
    case "watcher":
      return 2;
  }
}

function requireResponsibilityRepository(store: AppStore): ResponsibilityRepository {
  if (!store.responsibilities) {
    validation("Responsibility repository is not available.");
  }
  return store.responsibilities;
}
