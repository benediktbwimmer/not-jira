# unblock

Dependency-first project management for implementation work.

This repository is a TypeScript workspace with four packages:

- `@unblock/core`: domain types, service layer, repository contracts, SQLite store, import/export.
- `@unblock/cli`: `unblock` command line interface.
- `@unblock/server`: Hono HTTP API over the same service layer.
- `@unblock/web`: React/Vite UI for the ready queue, task details, tracks, tags, and activity.

The core service layer depends on `AppStore` repository interfaces, not SQLite.
The V1 concrete store is `createSqliteStore`, and a future Postgres store should
only need to implement the same repositories and transaction contract.

## Quick Start

```sh
npm install
npm run build
npm run test
npm link
unblock task add --id AUTH-001 --title "Add AST capture"
unblock task list --status ready
```

By default the SQLite database lives at `~/.unblock/unblock.sqlite`. Override
it with `--db` or `UNBLOCK_DB`.

Runtime UI settings live in `~/.unblock/config.json` and are created by
`unblock serve` if missing:

```json
{
  "ui": {
    "refreshIntervalMs": 5000,
    "persistState": true
  }
}
```

Run the API:

```sh
unblock serve
```
