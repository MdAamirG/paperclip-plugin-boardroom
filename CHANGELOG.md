# Changelog

All notable changes to this plugin are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - Unreleased

First release. Not yet published to npm and not yet checked by hand on a running Paperclip instance (see `docs/manual-check-0.1.0.md`).

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
