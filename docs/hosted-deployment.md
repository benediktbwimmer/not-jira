# Hosted Deployment

Hosted Unblock runs the core API against Postgres, uses WorkOS AuthKit access
tokens for tenant identity, and keeps connector credentials in encrypted hosted
secret envelopes. SQLite remains the local mode and does not require any of
this configuration.

## Processes

- API: `UNBLOCK_BACKEND=hosted npm run dev -w @unblock/server` in development,
  or the built `@unblock/server` entrypoint in production.
- Migration: start the API or run the existing database migration command with
  `UNBLOCK_BACKEND=hosted` and `UNBLOCK_POSTGRES_URL` set.
- Connector worker: future hosted-only process. It should use the same
  Postgres database, secret key, and WorkOS tenant identity model, while Prism
  Flows owns durable connector orchestration.

## Required Environment

Use [.env.hosted.example](../.env.hosted.example) as the deployment contract.
The required values are:

- `UNBLOCK_BACKEND=hosted`
- `UNBLOCK_POSTGRES_URL`
- `WORKOS_CLIENT_ID`
- `UNBLOCK_HOSTED_SECRET_KEY`

`UNBLOCK_HOSTED_SECRET_KEY` must decode to 32 bytes. Prefer `base64:<value>`
from a managed secret store. Rotate by setting a new key plus
`UNBLOCK_HOSTED_SECRET_KEY_ID`, then rotating stored credentials through the
hosted secrets API.

## Runtime Checks

- `GET /api/health` returns basic process health and active mode.
- `GET /api/admin/me` returns the current hosted principal, tenant, roles, and
  permissions.
- `GET /api/hosted/config` returns a redacted readiness report for database,
  WorkOS, secret, rate-limit, and structured-log configuration.
- `GET /api/hosted/metrics?projectId=...` returns tenant/project task counts
  suitable for dashboards and smoke checks.
- `GET /api/audit` exports immutable hosted audit events.

All hosted-only routes require hosted auth. Local SQLite and self-hosted
Postgres deployments should not enable these endpoints.

## Boundaries

- Local SQLite must not require WorkOS, Postgres, Prism, or hosted secrets.
- Self-hosted Postgres can use the native Postgres store without hosted
  WorkOS auth or connector workers.
- Hosted Postgres derives tenant scope from the WorkOS organization in the
  verified access token. Do not use a global `UNBLOCK_TENANT_ID` in hosted
  request handling.
- Connector credentials must only be accepted on create/rotate requests and
  must be returned as redacted metadata.
