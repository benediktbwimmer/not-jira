import { describe, expect, it } from "vitest";
import {
  connectorEvent,
  connectorEventFromOutbox,
  connectorTriggerFromOutbox,
  inboxEventForConnector,
  outboxEventForConnector
} from "./connector-events.js";

describe("connector event contracts", () => {
  it("normalizes connector events with stable correlation and idempotency keys", () => {
    const event = connectorEvent({
      kind: "connector.inbound.task_upserted",
      scope: { tenantId: "TENANT", projectId: "PROJECT", connectionId: "github-main", provider: "github" },
      external: { system: "github", kind: "issue", id: "42", url: "https://github.com/acme/repo/issues/42" },
      task: { id: "GH-42", title: "Imported issue" },
      evidence: { deliveryId: "delivery-1" }
    });

    expect(event.correlationId).toBe("TENANT:PROJECT:external:github:issue:42");
    expect(event.idempotencyKey).toContain("TENANT:PROJECT:github-main:connector.inbound.task_upserted");
    expect(event.task).toMatchObject({ id: "GH-42", lifecycle: "open", priority: 2 });
  });

  it("round-trips connector events through outbox and inbox envelopes", () => {
    const event = connectorEvent({
      kind: "connector.outbound.local_changed",
      scope: { tenantId: "TENANT", projectId: "PROJECT", connectionId: "github-main", provider: "github" },
      local: { kind: "task", id: "API" }
    });
    const outbox = outboxEventForConnector(event);
    const inbox = inboxEventForConnector(event);

    expect(connectorEventFromOutbox(outbox)).toEqual(event);
    expect(connectorTriggerFromOutbox(outbox)).toMatchObject({
      event,
      outboxEventId: outbox.id,
      attempt: 0
    });
    expect(inbox).toMatchObject({
      projectId: "PROJECT",
      source: "prism-flows",
      externalEventId: event.idempotencyKey,
      eventType: event.kind
    });
  });
});
