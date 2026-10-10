# Changelog

All notable changes to this plugin are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - Unreleased

First release. Not yet published to npm. Checked once by hand on a local Paperclip instance (see `docs/manual-check-0.1.0.md`); the fixes for that check are listed under Fixed.

### Fixed

- A multi-Turn Round no longer stops after the first Turn in a company that has no plugin configuration row (manual check F1). The host refuses worker calls made outside an invocation (a live agent reply, a job) for such a company. Settling a Turn now saves the outcome and reply at once and does the host-side work (activity entry, closing the session, starting the next Turn) from the next context the host accepts: a run event, a page request, or the sweep. The host's refusal is recognised by its error code and in all its wordings (including "company context is required"), and the next Turn never starts before the previous reply is saved. Adds migration `002_turn_host_pending.sql`.
- With no page open, a Round in a company without a plugin configuration row no longer stops after each posted reply (manual check F9). The host sends an agent's live reply just before its run-finished event, so the run event used to arrive while the reply was still being saved. It then found nothing it could finish, and the live reply was not allowed to do the host-side work. The run event now waits (bounded) for the reply to be saved, then finishes the Turn and starts the next one itself.
- A refused session start is only a skipped Turn when the host refused the agent itself (not invokable, paused, over budget, gone, company not active, skipped by its wake policy). Any other error fails the Turn with the real error text (F2).
- The page polls (5 s during a Round, 30 s otherwise, not while hidden) when the host's live stream is off, and the notice no longer tells the person to reload (F5).
- Markdown lists keep their bullets and numbers (F8).
- Stop while a Turn is still starting no longer lets that Turn's run start: the Turn is skipped as stopped and its session closed. A run whose send was in flight is cancelled once it exists, when the host offers the session-run cancel.
- A posted Turn whose reply the sweep had to recover (the worker stopped between settling the Turn and linking its Message) gets one "Turn posted" or "Turn failed" activity entry instead of two, and its session is closed.
- README: retries, known limits and access notes corrected after the manual check (F3, F4, F7).

### Added

- Rooms: durable, human-led discussions with a title, topic, optional project and linked issue, an Owner and up to 8 Participants; Participants can be edited between Rounds; a Room can be closed.
- Messages: attributed transcript with notes (no run starts), `@` mentions and "Ask all"; sends are safe to retry (idempotency key).
- Rounds and Turns: each addressed agent gets at most one Turn, run serially in a new agent session; Pause, Resume and Stop; a turn cap per Room (default 40) with an 80% warning; no automatic retries.
- Recovery: a once-a-minute sweep and host run events settle Turns whose live event was lost, without duplicating Messages.
- Cost visibility: per-Turn, per-agent and per-Room spend and tokens, with the turn cap state.
- Decision record on each Room.
- Follow-up work: create an ordinary issue from a Room (optional plan document, project, assignee, priority) or link an existing issue; a "From Room" chip on issues. A user assignee must be an active company member.
- Roles: viewer, operator, Room Owner, company owner and admin (see the README).
- Activity log entries for mutating actions, with the acting user in their details.

### Compatibility notes (0.x)

- Stop falls back to the board cancel route called from the page.
- Cost is attributed to the agent only.
- Activity entries name the plugin as actor, with the acting user in their details.
- Declares only capabilities that current hosts know, including `projects.read`.
