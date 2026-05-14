# Core Storage Contract

Unblock storage implementations must satisfy the `AppStore` contract from
`packages/core/src/store.ts`. The service layer owns domain semantics; stores
own durable persistence, indexes, transactions, and optional query acceleration.

## Required Repositories

Every core store must implement:

- `projects`: project namespace lifecycle.
- `tasks`: task CRUD, lifecycle state, parent hierarchy fields, archive state,
  and optimistic `version`.
- `dependencies`: explicit hard dependency edges.
- `comments`: flat chronological markdown comments.
- `tags`: project tag catalog plus task-tag assignment.
- `tracks`: actor queues plus exclusive task assignment.
- `instructions`: matcher-backed instruction records.
- `views`: named matcher views.
- `feeds`: named ready-work matcher feeds.
- `activity`: append-only local provenance stream.
- `migrations`: applied migration tracking.

The optional `matcher` repository can accelerate matcher queries. It does not
change matcher semantics; the matcher AST and service-layer result contract
remain authoritative.

## Transaction Contract

`AppStore.transaction(fn)` must provide all-or-nothing writes for a service
operation. The service layer assumes domain mutations and their activity records
commit together.

Required properties:

- On success, all writes inside `fn` are durable.
- On failure, no writes inside `fn` are visible.
- Nested service calls inside `fn` see a consistent view of previous writes in
  the same transaction.
- The repository instances passed to `fn` enforce the same project scoping and
  uniqueness constraints as the top-level store.

## Semantic Contract

Stores must preserve the behavior in `services.ts`:

- Project-scoped task IDs.
- Project-scoped tags, tracks, instructions, views, feeds, comments, and
  dependencies.
- Parent/child hierarchy constraints.
- Dependency cycle prevention.
- Rejection of dependency edges between ancestors and descendants.
- Finished parent tasks cannot contain unfinished children.
- Finished tasks cannot be assigned.
- Archived tasks cannot receive dependency/tag/assignment changes.
- Track assignment is exclusive per task.
- Activity is appended for every mutating service path.
- Import/export can round-trip supported core data.
- Matcher reads cover fields, tags, assignments, lifecycle, hierarchy,
  dependencies, comments, source metadata, and time predicates.

## Store Capabilities

`AppStore.capabilities` describes implementation-level behavior for diagnostics
and benchmark reporting:

- `dialect`: `memory`, `sqlite`, `postgres`, `hosted`, or `prism`.
- `transactionalWrites`: whether `transaction` is durable and atomic.
- `coreDomain`: whether the store implements the full core repository set.
- `comments`: whether comments are implemented.
- `matcherQuery`: `service` for service-layer matcher evaluation or `store` for
  store-accelerated matcher execution.
- `bulkOperations`: whether bulk create/assign/dependency helpers are
  implemented.
- `outboxInbox`: whether hosted connector outbox/inbox repositories are
  implemented.

SQLite currently reports service-level matcher evaluation and no outbox/inbox.
Postgres should report store-level matcher once SQL lowering lands, and
outbox/inbox after hosted connector primitives land.

## Non-Goals

The core contract does not include hosted-only auth, WorkOS organization data,
connector credentials, Prism Flows runs, or enterprise audit export. Those build
on top of the core store for hosted mode, but they must not be required by the
local SQLite path.
