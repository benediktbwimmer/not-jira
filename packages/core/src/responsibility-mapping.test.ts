import { describe, expect, it } from "vitest";
import {
  assignExternalAssigneeResponsibility,
  createDelegationRuleRecord,
  createPrincipalRecord,
  resolveTaskDelegations,
} from "./responsibility-mapping.js";
import type { AppStore, ResponsibilityRepository } from "./store.js";
import type {
  DelegationRule,
  ExternalIdentity,
  Principal,
  TaskResponsibility,
  TaskView,
} from "./types.js";

describe("responsibility mapping", () => {
  it("maps external assignees to accountable principals without touching actor queues", async () => {
    const repo = new InMemoryResponsibilityRepository();
    const store = { responsibilities: repo } as AppStore;
    const principal = createPrincipalRecord({
      tenantId: "tenant",
      id: "principal-alice",
      kind: "user",
      displayName: "Alice",
      email: "alice@example.com",
    });
    await repo.upsertPrincipal(principal);
    await repo.upsertExternalIdentity({
      tenantId: "tenant",
      connectionId: "jira-main",
      provider: "jira",
      externalKind: "user",
      externalId: "account-123",
      externalDisplayName: "Alice A.",
      externalEmail: "alice@example.com",
      principalId: principal.id,
      confidence: "verified",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
    });

    const result = await assignExternalAssigneeResponsibility(store, {
      tenantId: "tenant",
      projectId: "UNBLOCK",
      taskId: "TASK-1",
      connectionId: "jira-main",
      provider: "jira",
      externalKind: "user",
      externalId: "account-123",
      externalDisplayName: "Alice A.",
      externalEmail: "alice@example.com",
    });

    expect(result.status).toBe("mapped");
    expect(result.responsibility).toMatchObject({
      projectId: "UNBLOCK",
      taskId: "TASK-1",
      principalId: "principal-alice",
      role: "owner",
      source: "connector",
    });
    expect(await repo.listTaskResponsibilities({ projectId: "UNBLOCK" }))
      .toHaveLength(1);
  });

  it("keeps unknown external assignees unmapped for operator review", async () => {
    const repo = new InMemoryResponsibilityRepository();
    const result = await assignExternalAssigneeResponsibility(
      { responsibilities: repo } as AppStore,
      {
        tenantId: "tenant",
        projectId: "UNBLOCK",
        taskId: "TASK-1",
        connectionId: "github-main",
        provider: "github",
        externalKind: "user",
        externalId: "octocat",
        externalDisplayName: "octocat",
      },
    );

    expect(result.status).toBe("unmapped");
    expect(result.externalIdentity).toMatchObject({
      externalId: "octocat",
      principalId: null,
      confidence: "unmapped",
    });
    expect(await repo.listTaskResponsibilities({ projectId: "UNBLOCK" }))
      .toEqual([]);
  });

  it("resolves matcher-scoped delegation rules by priority", () => {
    const task = taskView({ id: "TASK-1", priority: 4 });
    const responsibilities: TaskResponsibility[] = [{
      tenantId: "tenant",
      projectId: "UNBLOCK",
      taskId: "TASK-1",
      principalId: "principal-alice",
      role: "owner",
      source: "connector",
      createdAt: "2026-05-16T00:00:00.000Z",
      updatedAt: "2026-05-16T00:00:00.000Z",
      archivedAt: null,
    }];
    const rules = [
      createDelegationRuleRecord({
        tenantId: "tenant",
        projectId: "UNBLOCK",
        id: "default",
        principalId: "principal-alice",
        targetKind: "track",
        targetId: "codex-a",
        priority: 0,
      }),
      createDelegationRuleRecord({
        tenantId: "tenant",
        projectId: "UNBLOCK",
        id: "high-priority",
        principalId: "principal-alice",
        targetKind: "track",
        targetId: "codex-e",
        scopeQuery: "priority >= 4",
        priority: 10,
      }),
    ];

    expect(resolveTaskDelegations({
      task,
      allTasks: [task],
      dependencies: [],
      responsibilities,
      rules,
    })).toMatchObject([{
      targetKind: "track",
      targetId: "codex-e",
      rule: { id: "high-priority" },
    }]);
  });
});

function taskView(overrides: Partial<TaskView>): TaskView {
  return {
    projectId: "UNBLOCK",
    id: "TASK-1",
    parentTaskId: null,
    title: "Task",
    description: "",
    lifecycle: "open",
    computedStatus: "ready",
    priority: 2,
    size: null,
    sourceDoc: null,
    sourceSection: null,
    sourceAnchor: null,
    sourceLine: null,
    sourceText: null,
    completionBar: null,
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    archivedAt: null,
    version: 1,
    ready: true,
    blocked: false,
    unfinishedDependenciesCount: 0,
    finishedDependenciesCount: 0,
    dependencyDepth: 0,
    dependentsCount: 0,
    transitiveDependentsCount: 0,
    parent: null,
    childrenCount: 0,
    descendantsCount: 0,
    leafDescendantsCount: 0,
    finishedLeafDescendantsCount: 0,
    subtreeProgress: 0,
    subtreeOpenCount: 0,
    subtreeReadyCount: 0,
    subtreeBlockedCount: 0,
    subtreeStartedCount: 0,
    subtreeFinishedCount: 0,
    hierarchyDepth: 0,
    assignedTrack: null,
    tags: [],
    commentCount: 0,
    recentCommentCount: 0,
    lastCommentAt: null,
    commentAuthors: [],
    ...overrides,
  };
}

class InMemoryResponsibilityRepository implements ResponsibilityRepository {
  principals: Principal[] = [];
  identities: ExternalIdentity[] = [];
  responsibilities: TaskResponsibility[] = [];
  rules: DelegationRule[] = [];

  async upsertPrincipal(principal: Principal): Promise<void> {
    this.principals = upsertBy(this.principals, principal, (item) => item.id);
  }

  async getPrincipal(id: string): Promise<Principal | null> {
    return this.principals.find((principal) => principal.id === id) ?? null;
  }

  async listPrincipals(): Promise<Principal[]> {
    return [...this.principals];
  }

  async upsertExternalIdentity(identity: ExternalIdentity): Promise<void> {
    this.identities = upsertBy(
      this.identities,
      identity,
      (item) => `${item.connectionId}:${item.provider}:${item.externalKind}:${item.externalId}`,
    );
  }

  async getExternalIdentity(
    connectionId: string,
    provider: string,
    externalKind: ExternalIdentity["externalKind"],
    externalId: string,
  ): Promise<ExternalIdentity | null> {
    return this.identities.find((identity) =>
      identity.connectionId === connectionId &&
      identity.provider === provider &&
      identity.externalKind === externalKind &&
      identity.externalId === externalId
    ) ?? null;
  }

  async listExternalIdentities(): Promise<ExternalIdentity[]> {
    return [...this.identities];
  }

  async upsertTaskResponsibility(responsibility: TaskResponsibility): Promise<void> {
    this.responsibilities = upsertBy(
      this.responsibilities,
      responsibility,
      (item) => `${item.projectId}:${item.taskId}:${item.principalId}:${item.role}`,
    );
  }

  async listTaskResponsibilities(options: { projectId: string }): Promise<TaskResponsibility[]> {
    return this.responsibilities.filter((item) =>
      item.projectId === options.projectId && item.archivedAt === null
    );
  }

  async archiveTaskResponsibility(): Promise<TaskResponsibility | null> {
    return null;
  }

  async upsertDelegationRule(rule: DelegationRule): Promise<void> {
    this.rules = upsertBy(this.rules, rule, (item) => `${item.projectId}:${item.id}`);
  }

  async listDelegationRules(): Promise<DelegationRule[]> {
    return [...this.rules];
  }
}

function upsertBy<T>(items: T[], next: T, key: (item: T) => string): T[] {
  const nextKey = key(next);
  const index = items.findIndex((item) => key(item) === nextKey);
  if (index < 0) return [...items, next];
  const copy = [...items];
  copy[index] = next;
  return copy;
}
