# Boardroom for Paperclip

Boardroom adds human-led discussion Rooms to [Paperclip](https://github.com/paperclipai/paperclip). A board operator opens a Room on one decision or problem, adds the agents who should take part, and runs Rounds in which each addressed agent takes at most one Turn. The Room ends in a Decision record and ordinary Paperclip issues.

> Status: in development (`0.1.0-dev.0`). Not published to npm yet. Full documentation comes with the first release.

- Manifest id: `mdaamirg.boardroom`
- Built on the published `@paperclipai/plugin-sdk@2026.1005.0`
- Licence: MIT

## Development

```bash
pnpm install
pnpm typecheck
pnpm test        # Vitest: worker tests on PGlite, UI tests on jsdom
pnpm build       # dist/manifest.js, dist/worker.js, dist/ui/
pnpm dev         # watch build
```

Install a local build into a Paperclip instance:

```bash
paperclipai plugin install /absolute/path/to/paperclip-plugin-boardroom
```

## Capabilities

The manifest declares: the plugin database namespace (migrate, read, write); `agents.read`; `projects.read` (Room creation checks that the chosen project belongs to the company); agent sessions (create, send, close); `access.members.read`; issues (read, create) and issue documents (write); activity log (write); events (subscribe); jobs (schedule); API routes (register); and UI page, sidebar and action registration. A manifest that declares a capability the host does not know fails to install, so the list only grows with the host.

Follow-up work uses `issues.read` (the live work list and the link check), `issues.create` (the new task has origin kind `plugin:mdaamirg.boardroom`, origin id = the Room id and `actor.actorUserId` = the acting user) and `issue.documents.write` (the optional `plan` document). All three names are valid in `@paperclipai/plugin-sdk@2026.1005.0`. The host's own HTTP status for a refused task creation does not reach the plugin (the RPC carries a message and a numeric code), so a refusal is answered 422 `issue_create_failed` with the host's message, unless the error carries its own status.

## Access and company roles

The plugin reads the caller's company role on every request (`ctx.access.members`): owner, admin and operator may post, a viewer may only read, and the Room Owner or a company owner or admin controls a Room. A membership with no role counts as an operator; an unrecognised role counts as a viewer.

In local trusted mode the board user (`local-board`) is a company member only because the host seeds an owner membership for it at startup, and when a company is imported (`POST /companies/import`). A company created any other way has no such membership, so the Boardroom API answers `403 not_a_company_member` for the local board user until the host restarts.

## Repository layout

- `src/manifest.ts`, `src/worker.ts`, `src/ui/`: the plugin. `src/api/` holds the plugin API (route table, access, audit, live updates, handlers); `src/db/` the company-scoped data access.
- `migrations/`: SQL migrations the host applies to the plugin's database namespace, in filename order. Qualify every object with the host-derived schema name `plugin_boardroom_79f8e138fc`.
- `tests/`: worker tests (`*.spec.ts`) and UI tests (`*.spec.tsx`). `tests/support/` holds the test harness.
- `docs/`: the spec, the glossary (`CONTEXT.md`) and the architecture decision records.

## Test harness

`tests/support/harness.ts` wraps the SDK test harness with a host that behaves like the real one (database, API route dispatch, sessions, streams, host records kept across `restart()`). Each module under `tests/support/host/` says which host code it mirrors.

Known ambiguities:

- Host version is not exposed: the SDK (2026.1005.0) receives `hostVersion` only in the `initialize` RPC and does not put it on `ctx`, so the worker's startup log records `hostVersion: null`.
- The host accepts the manifest id as `:pluginId` in `/api/plugins/:pluginId/api/*` (its router resolves a key or a database id); the harness dispatches on the plugin-local path only.
- The harness mirrors host release 2026.1005.0 and the drizzle 0.45.2 parameter binding; recheck both when the pinned SDK changes.
