# Boardroom for Paperclip

Boardroom adds human-led discussion **Rooms** to [Paperclip](https://github.com/paperclipai/paperclip). A board operator opens a Room on one decision or problem, adds the agents who should take part, and runs Rounds in which each addressed agent takes at most one Turn. The Room ends in a Decision record and ordinary Paperclip issues.

- Version: `0.1.0` (first release; see `CHANGELOG.md`)
- Manifest id: `mdaamirg.boardroom`
- Built on the published `@paperclipai/plugin-sdk@2026.1005.0`
- Licence: MIT

## What it is

The terms below are used the same way everywhere in the plugin (the full glossary is in `docs/CONTEXT.md`).

- **Room**: one durable discussion about a single topic, owned by a board operator. The board can edit its Participants between Rounds.
- **Participant**: an agent explicitly added to a Room (at most 8 active). Only Participants can be addressed or take Turns.
- **Owner**: the board user who created the Room and controls it: starts, pauses and stops Rounds, edits Participants and settings, closes the Room and records its Decision record. Company owners and admins have the same control. The Owner is not a Participant.
- **Message**: a durable, author-attributed contribution to a Room by the Owner, another board user, or a Participant. A Message without a mention is a note: no run starts.
- **Round**: one human-initiated pass in which each addressed agent gets at most one Turn, after which control returns to the human. Mention agents with `@`, or use "Ask all" to address every active Participant in join order.
- **Turn**: a single agent run that reads the Room and posts at most one Message. Turns run one at a time, in order. A Turn can end posted, silent (the run produced no reply), failed or skipped.
- **Follow-up work**: an ordinary Paperclip issue created from a Room (with an optional plan document) or an existing issue linked to it. Either way the issue shows a "From Room" chip.
- **Decision record**: the outcome the Owner writes down on a Room: what was decided and why. It belongs to the Room, not to any issue.

Rooms are not issues: they do not appear in the issue list. Follow-up work does.

## Install

Enabling the plugin is the on/off switch. There is no experimental flag and no plugin setting. While the plugin is not installed or is disabled, the sidebar entry is absent and the plugin's routes answer 404 or 503 (this is the host's behaviour and is part of the manual check).

From a local path:

```bash
pnpm install
pnpm build
paperclipai plugin install /absolute/path/to/paperclip-plugin-boardroom
```

From npm (once published; it has not been published yet):

```bash
paperclipai plugin install paperclip-plugin-boardroom
```

## Capabilities

The manifest declares these capabilities (the 0.x list). Each is needed for a specific reason:

| Capability | Why |
| --- | --- |
| `database.namespace.migrate`, `.read`, `.write` | Rooms, Participants, Messages, Rounds, Turns and work links live in the plugin's own database namespace. |
| `agents.read` | Check that chosen agents belong to the company and show their names. |
| `projects.read` | Check that a Room's or follow-up task's project belongs to the company. (Not in the original spec list; added during the build.) |
| `agent.sessions.create`, `.send`, `.close` | Each Turn is one new agent session with one message; the session is closed when the Turn ends. |
| `access.members.read` | Read the caller's company role on every request, and validate user assignees. |
| `issues.read` | Show live follow-up work and check an issue before linking it. |
| `issues.create` | Create follow-up tasks, with the plugin origin and the acting user as creator. |
| `issue.documents.write` | Save the optional plan document on a created task. |
| `activity.log.write` | Record mutating actions in the activity log. |
| `events.subscribe` | Settle Turns when the host reports a run finished, failed or cancelled. |
| `jobs.schedule` | A once-a-minute sweep settles Turns whose live event was lost and continues idle Rounds. |
| `api.routes.register` | The plugin API used by the page. |
| `ui.page.register`, `ui.sidebar.register`, `ui.action.register` | The Boardroom page, the sidebar entry and the "From Room" chip on issues. |

The plugin also reads the host tables `companies` (foreign keys only), `heartbeat_runs`, `cost_events` and `agents` (the manifest's `coreReadTables`) for run results and cost.

Follow-up work uses `issues.read`, `issues.create` (the new task has origin kind `plugin:mdaamirg.boardroom`, origin id = the Room id and `actor.actorUserId` = the acting user) and `issue.documents.write` (the optional `plan` document). The host's own HTTP status for a refused task creation does not reach the plugin, so a refusal is answered 422 `issue_create_failed` with the host's message, unless the error carries its own status. A user assignee must be an active member of the company (422 `user_not_in_company`).

The "From Room" chip is a `toolbarButton` slot on issues. It calls `GET /issues/:issueId/rooms`, which reads `work_links` only (a created or a linked task shows it), scoped to the company the host resolves from the issue.

A manifest that declares a capability the host does not know fails to install, so the 0.x list contains only capabilities current hosts know.

## Compatibility

Built and tested against Paperclip host release 2026.1005.0 and the SDK of the same version. 0.x is written to work on current Paperclip releases. What is reduced in 0.x:

- **Stop** uses the board cancel route (`POST /api/heartbeat-runs/:id/cancel`) called from the page. The plugin first tries the host's session-run cancel and falls back when the host does not offer it.
- **Cost** is attributed to the agent only, not to the Owner who started the Round or to the Room's project.
- **Activity entries** name the plugin as actor, with the acting user in their details (`actingUserId`).

A later release is planned that declares two further capabilities (`agent.sessions.send_human_attributed`, `activity.log.write_human_attributed`), passes the user and project on session sends and the user on activity entries, and states the minimum host version. It depends on host changes that are not part of 0.1.0.

## Roles

The plugin reads the caller's company role on every request. Agents cannot use the Boardroom API.

| Role | Can |
| --- | --- |
| Viewer | Read Rooms, Messages, Rounds, cost and follow-up work. Cannot post. |
| Operator (and a membership with no role) | Everything a viewer can, plus: create Rooms (becoming their Owner), post notes, create follow-up work and link issues. Controls only Rooms they own. |
| Room Owner | Controls their Room: start a Round (mention agents or Ask all), Pause, Resume, Stop, edit Participants and settings, close the Room, record the Decision record. |
| Company owner or admin | The same control over every Room in the company, including starting Rounds. |

Starting a Round requires control of the Room: an operator who is not the Owner can post notes but a mention from them does not start a Round (403 `round_not_allowed`). An unrecognised role counts as a viewer.

## Turn cap, warning and retries

- Each Room has a turn cap, 1 to 200, default 40. A Round is refused (422 `turn_cap_reached`) when the Turns already counted plus the new Turns would exceed the cap. Turns skipped before their run started do not count.
- At 80% of the cap or more the Room shows a warning ("Warning: 80% or more of the turn cap is used. Rounds stop at the cap."). At the cap it says a new Round needs a higher cap. The Owner can raise the cap in the Room settings.
- **The Boardroom itself never retries.** A failed or silent Turn stays that way; to retry an agent, start another Round addressed to it. The Boardroom never starts a run without the Owner's action. One exception is outside the plugin's control: when the host loses a run (for example after a hard kill of the server, reported as `process_lost`), the host may start its own retry run for that agent. That run is not part of any Turn, spends tokens and its reply is not posted in the Room. Boardroom cannot prevent or cancel it.
- If an agent is paused in Paperclip when its Turn comes up, the Turn is skipped with the host's message.
- If the worker or host restarts during a Turn, the Turn is settled from the run's recorded result without duplicating the Message. This happens within about a minute of the host ending the run; after a hard kill the host itself can take several minutes to declare the run lost, and the Turn cannot settle before that.

## Known limits

- **Adapters:** the manual check (`docs/manual-check-0.1.0.md`) confirmed `claude_local` only. `gemini_local` did not answer (the account was rate limited), so no second adapter is confirmed. Treat other adapters as untested.
- **One local host run.** The manual check ran on one local Paperclip instance (`local_trusted`, embedded Postgres), mostly through the plugin API, with the UI checked in headless Chromium. The host assumptions it listed held (run events for the plugin's own runs, `actor.actorUserId` on `issues.create`, the issue-page `toolbarButton`, cost on the run id, an unshortened `result_json.summary` for a 2,274-character reply, the board cancel route). Not verified: a viewer account, budgets (subscription runs cost nothing), a working second adapter, transcript scroll-follow, the mention list position, and larger replies.
- **Stop cancels through the page.** The host does not offer a session-run cancel to plugins, so Stop hands the run id to the page, which cancels it with the board route (`POST /api/heartbeat-runs/:id/cancel`). Stop only fully works from the page.
- **Permissions of agents are the host's.** Boardroom adds no restriction: an agent in a Turn runs with its normal adapter permissions (for ACP engines the adapter default, `approve-all`) and can run shell commands. Budgets are applied by the host; a refused wake shows as a skipped Turn.
- The Decision record author shows as "You" or "Board user <id prefix>": the host member record has no display name. For the same reason `authorName` is `null` for a board user in Message responses; the page shows "You" for your own Messages, "Board" for the local board user and "Board user <id prefix>" for others.
- **Live updates depend on the host.** The host must enable its plugin stream bridge; the Paperclip build used in the manual check answered 501 ("Plugin stream bridge is not enabled"). When the stream is off, the page shows a small "Live updates are off" status and keeps itself fresh by polling: every 5 seconds while a Round is active, every 30 seconds otherwise, and not while the tab is hidden. With the stream on, the stream keeps every event for the session (it resets on reconnect or company change).
- **No plugin settings, no configuration row needed.** The host admits a plugin's calls made outside a request (a live agent reply, a job) only for a company with a plugin configuration row, and Boardroom has no settings, so it never has one. Boardroom therefore finishes Turns in two steps: the reply is saved at once, and the host-side work (activity entry, closing the session, starting the next Turn) runs when the host next calls the plugin for that company: a run event (normally within a second or two), a request from the page, or the minute sweep when the company has a configuration row. If you see a Round pause between Turns for longer, check that the run events arrive.
- A Stop sent while a Turn is still starting starts no run for it (the Turn is skipped as stopped). A Stop that lands during the send itself is followed by a cancel once the run exists, but only through the host's session-run cancel; with the page fallback that run finishes normally.
- A paused Round does not expire; it keeps the Room locked for edits and Close until resumed or stopped.
- A Turn whose run id was never stored (the worker died inside the send) is failed by the sweep after 5 minutes.
- A Room is limited to 8 active Participants. Body, title, topic and plan sizes have limits (see `docs/spec-plugin.md` and `src/constants.ts`).

## Access notes

The plugin reads the caller's company role on every request (`ctx.access.members`): owner, admin and operator may post, a viewer may only read, and the Room Owner or a company owner or admin controls a Room. A membership with no role counts as an operator; an unrecognised role counts as a viewer.

In local trusted mode the board user (`local-board`) is a company member (role `owner`) in the check that was run, including for a company created with `POST /api/companies`, so no restart was needed. Earlier notes said the membership exists only for the startup seed and company import; that did not hold in the manual check. If the Boardroom API ever answers `403 not_a_company_member` for the local board user, the host has not created the membership; restart the host. A viewer account was not exercised on a real host (the instance mode has none); the role matrix is covered by the automated tests only.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test        # Vitest: worker tests on PGlite, UI tests on jsdom
pnpm build       # dist/manifest.js, dist/worker.js, dist/ui/
pnpm dev         # watch build
```

Releasing: see `docs/RELEASING.md`.

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
