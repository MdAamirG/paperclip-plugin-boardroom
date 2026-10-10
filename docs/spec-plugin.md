---
title: Boardroom plugin — multi-agent discussion rooms
labels: [ready-for-agent]
source: https://github.com/paperclipai/paperclip/issues/14143
map: ./map.md
glossary: ./CONTEXT.md
adr: ./adr/0002-boardroom-is-a-plugin.md
supersedes: ./spec.md (core design)
status: ready-for-agent
---

## Problem Statement

A board operator sometimes needs several specialist agents to reason about one decision together before any work is created. For example, an engineering lead, a planner, a researcher and a backend engineer might weigh an architecture choice. Today the only shared surface is issue comments. Comments model work, not deliberation:

- They have no explicit membership.
- They have no bounded rounds and no lifecycle for the discussion.
- They give no view of what a discussion cost.
- Mentioning agents in comments can wake them recursively, so an open agent-to-agent exchange can spend tokens without producing anything.

The operator has nothing between "we need to reason about this" and "create tasks and execute it". The project also wants optional chat-like surfaces to live in plugins rather than in core, so the answer must be a plugin.

## Solution

A Paperclip plugin, **Boardroom**, published to npm as `paperclip-plugin-boardroom`. When it is installed and enabled, a board operator can open the Boardroom page from the sidebar.

- **Rooms and Participants:** the operator (the **Owner**) creates a **Room** about one topic and chooses up to eight agent **Participants**.
- **Messages and Rounds:**
  - Everyone can see a durable, attributed record of **Messages**.
  - Each send either addresses specific Participants by mention or asks all of them. It starts a **Round**: each addressed agent takes at most one **Turn**, one after another, and then control returns to the Owner.
  - A send with no mention and no "Ask all" is a note and wakes nobody.
- **Agents in a Turn:** each agent answers from a fresh session that is given the recent transcript. Agents may disagree. No agent can wake another agent.
- **Owner controls:** the Owner can pause, resume or stop a Round and close the Room.
- **Cost:** spend is visible per Room, per agent and per Turn, and a per-Room turn cap bounds it.
- **Outcomes:** the Owner records a **Decision record** on the Room. Anyone who can post can create **Follow-up work** (an ordinary issue that points back to the Room, optionally with a plan) or link an existing issue. A linked issue shows a "From Room" chip on its own page.

The plugin runs on current Paperclip releases with reduced attribution. Three small, generic additions to the plugin host, each a separate pull request to the Paperclip repo, add the full behaviour:

1. Cancel a running session run.
2. Attribute session sends to the human user and to a project.
3. Attribute activity entries to the human user.

A later plugin release requires a host that has them.

## User Stories

### Rooms and Participants

1. As an Owner, I want to create a Room with a title and topic, so that a discussion has a clear scope.
2. As an Owner, I want to pick which agents of my company join a Room, so that only the specialists I chose take part.
3. As an Owner, I want to optionally attach a project to a Room, so that its spend and its follow-up work are filed under that project.
4. As an Owner, I want to optionally link an existing issue when I create a Room, so that the discussion can inform that issue.
5. As an Owner, I want Room creation refused when I pick more than eight agents, so that rooms stay small and affordable.
6. As an Owner, I want Room creation refused when I pick an agent from another company, so that company boundaries hold.
7. As an Owner, I want to set a total-turn cap for the Room (default 40, range 1 to 200), so that one Room cannot run away.
8. As an Owner, I want to add or remove Participants between Rounds, so that I can bring in a specialist or drop one that is not helping.
9. As an Owner, I want Participant changes refused while a Round is running or paused, so that membership never changes during a Round.
10. As an Owner, I want a removed Participant's earlier Messages to keep their attribution, so that the record stays honest.
11. As an Owner, I want to edit the title, topic and turn cap while no Round is running, so that I can correct the Room's scope.
12. As an Owner, I want raising the turn cap after it was reached to be allowed and audited, so that I can extend a useful discussion on purpose.

### Sending and Rounds

13. As an Owner, I want to post a Message that mentions specific Participants, so that only they respond.
14. As an Owner, I want an "Ask all participants" send, so that every Participant responds once.
15. As a board user, I want a send with no mentions and no "Ask all" saved as a note that starts no Round, so that I can add context without spending tokens.
16. As an Owner, I want mentions of agents who are not Participants ignored, with a clear notice, so that I never wake agents I did not choose.
17. As an Owner, I want each addressed agent to take at most one Turn per Round, so that the cost per Round is predictable.
18. As an Owner, I want Turns to run one at a time, in the order I mentioned the agents (or the order they joined, for "Ask all"), so that the order is predictable.
19. As an Owner, I want each agent in a Round to see the Messages posted earlier in that Round, so that agents can respond to each other.
20. As an Owner, I want control to return to me when every Turn in a Round has finished, so that I decide what happens next.
21. As an Owner, I want a second Round refused while one is running or paused, so that Turns never overlap.
22. As an Owner, I want a Round refused when it would take the Room past its turn cap, so that the cap is a hard limit.
23. As an Owner, I want Turns that were skipped before they started not to count toward the cap, so that I am not charged for Turns that never ran.
24. As an Owner, I want my sends to be safe to retry, so that a flaky connection never duplicates a Message or a Round.

### Turns and outcomes

25. As an Owner, I want each Turn's outcome shown (posted, silent, failed or skipped), so that I know exactly what happened in a Round.
26. As an Owner, I want a Turn whose agent replies with nothing to show as silent, so that I can tell "no view" from "broken".
27. As an Owner, I want a Turn that fails to leave the rest of the Round intact, so that one broken agent does not block the others.
28. As an Owner, I want no automatic retries, so that tokens are never spent without my knowledge.
29. As an Owner, I want to retry an agent by starting another Round addressed to it, so that a retry is an explicit choice.
30. As an Owner, I want a Turn skipped, with Paperclip's own reason shown word for word, when its agent is over budget, paused or not invokable, so that existing governance still applies and I can see why.
31. As an Owner, I want Rounds to keep going correctly after the plugin restarts, so that a worker restart never leaves a Round stuck or runs a Turn twice.

### Pause, Stop and close

32. As an Owner, I want to Pause a Round so that the running Turn finishes but no new Turn starts, so that I can step back without losing the Round.
33. As an Owner, I want to Resume a paused Round so that it continues from where it stopped.
34. As an Owner, I want to Stop a Round so that the running Turn is cancelled and the remaining Turns are marked skipped, so that I have an emergency brake.
35. As an Owner, I want a stopped Round never to start another Turn, even if cancelling the running one fails, so that Stop is always safe.
36. As an Owner, I want a stopped Round to leave the Room open, so that I can continue with a fresh Round.
37. As an Owner, I want to close a Room, so that a finished discussion is clearly over.
38. As an Owner, I want a closed Room to accept no new Messages or Rounds, so that its record stays stable.

### Agent Participants

39. As an agent Participant, I want each Turn to give me the topic, the Participants and their roles, who was addressed and the recent Messages, so that I have the context I need.
40. As an agent Participant, I want to be told to reply with only my Message, that I may disagree, and not to call Paperclip APIs or create work, so that I answer the question instead of running my usual routine.
41. As an agent Participant, I want every Turn to start a fresh session built from the Room transcript, so that I behave the same on every adapter and never rely on stale memory.
42. As an agent Participant, I want my Messages attributed to me and to the run that produced them, so that the record shows who said what.
43. As an agent Participant, I want my role instructions, permissions and budgets to apply during a Turn, so that joining a Room never widens what I can do.
44. As a company admin, I want agents unable to post to a Room except through a Turn the Owner started, so that agent-to-agent chatter cannot recurse.

### Access and visibility

45. As a company member, I want to read any Room in my company, so that discussion is as visible as other company work.
46. As a board user who is not a viewer, I want to post notes in a Room, so that more than one operator can take part.
47. As a company owner or admin, I want the same control over a Room as its Owner, so that a Room is never stuck when its Owner is away.
48. As a viewer, I want to read Rooms but not post, so that the viewer role keeps its meaning.
49. As a board user, I want a Boardroom entry in the sidebar and a list of the company's Rooms with status and last activity, so that I can find and resume discussions.
50. As a board user, I want the Room page to update live as Turns progress, so that I do not need to reload.
51. As a board user, I want the Room page to survive a reload and show the full history, so that discussions are durable.
52. As a company admin, I want Rooms strictly scoped to their company, so that no data crosses company boundaries.
53. As a company admin, I want Rooms kept out of issue lists and counts, so that deliberation does not clutter work views.

### Cost

54. As a company admin, I want a Room's lifetime spend, tokens and run count, so that I can see which discussions are expensive.
55. As a company admin, I want spend broken down per agent, including removed Participants, so that I can see who is costly.
56. As an Owner, I want each Turn's cost shown on the Turn, so that I can relate cost to what was said.
57. As an Owner, I want a warning when the Room has used 80% of its turn cap, so that I am not surprised when it stops.
58. As a company admin, I want existing company and agent budget limits to gate every Turn, so that hard stops keep working.
59. As a company admin on a host with the attribution addition, I want each Turn's cost attributed to the Owner who started the Round and to the Room's project, so that responsibility is clear and project budgets apply.

### Outcomes and follow-up work

60. As an Owner, I want to write a Decision record on the Room, so that its outcome is recorded where the discussion happened.
61. As a board user who is not a viewer, I want to create follow-up work from a Room, with an optional plan, so that the discussion turns into real work.
62. As a board user, I want created follow-up work to go through ordinary issue creation, so that assignment, budgets and execution rules apply unchanged.
63. As a board user, I want follow-up work to default to the Room's project, so that it is filed in the right place.
64. As a board user, I want to link an existing issue to a Room, and unlink it, so that existing work can be tied to the discussion.
65. As a board user, I want to create and link work after a Room is closed, so that outcomes can be filed late.
66. As a reader of a follow-up issue, I want a "From Room" chip on the issue page, so that I can open the reasoning behind it.
67. As a board user, I want the Room page to list its follow-up work with status, so that I can track what came out of it.

### Audit and installation

68. As a company admin, I want every Room change in the activity log with the acting user, so that the discussion is auditable.
69. As an instance admin, I want the Boardroom to appear only when the plugin is installed and enabled, so that it can be trialled safely.
70. As an instance admin, I want the plugin to install on current Paperclip releases, so that I can try it without upgrading.
71. As an instance admin on an upgraded host, I want a plugin release that uses the new host additions, so that attribution and cancel work fully.

### Host additions (plugin authors, any plugin)

72. As a plugin author, I want to cancel the running run of a session my plugin owns, so that a plugin can offer an emergency stop.
73. As a plugin author, I want cancelling another plugin's session, or a session in another company, refused, so that plugins stay isolated.
74. As a plugin author, I want to send a session message on behalf of a verified active human member, so that cost and responsibility land on that person.
75. As a plugin author, I want to send a session message under a project of the same company, so that project budgets gate the run and cost carries the project.
76. As a plugin author, I want to write an activity entry attributed to a verified active human member, so that audit shows who acted through my plugin.
77. As an instance admin, I want each human-attributed action to require its own declared capability, so that I can see what a plugin may do before I install it.

## Implementation Decisions

### Packaging and compatibility

- **Home:** a standalone repository published to npm as `paperclip-plugin-boardroom`, under the MIT licence. The manifest id is author-namespaced. The plugin is built on the published plugin SDK. The Paperclip repo receives only the three host-addition pull requests.
- **0.x releases:**
  - They declare only capabilities that current hosts know, because a manifest that declares an unknown capability fails to install.
  - Stop falls back to the board cancel route.
  - Cost is attributed to the agent only.
  - Activity entries are plugin-attributed, with the acting user in their details.
- **Later release:** it declares the two new capabilities, passes the user and project on session sends and the user on activity entries, and states the minimum host version.
- **Detecting the cancel feature:** the plugin tries the call and falls back when the host does not support it. The plugin also records the host and API versions it receives at startup.

### On/off switch

Installing and enabling the plugin is the switch, so there is no experimental flag and no plugin setting. Plugin configuration is instance-wide, so a toggle would only repeat "enabled". The host already answers 404 or 503 for routes of a plugin that is missing or not ready.

### Capabilities (0.x)

- Plugin database namespace: migrate, read and write.
- Read access to the core tables for runs and cost events.
- Agents: read.
- Agent sessions: create, send and close.
- Access members: read.
- Issues: read and create.
- Issue documents: write.
- Activity log: write.
- Events: subscribe.
- Jobs: schedule.
- API routes: register.
- UI: page, sidebar and action registration.

The later release adds `agent.sessions.send_human_attributed` and `activity.log.write_human_attributed`.

### Plugin tables

All tables live in the plugin's database namespace. Every row carries the company id, and every query filters on it, because plugin SQL is not filtered by company.

- **rooms:**
  - title, topic and optional project;
  - Owner user id;
  - status `open` or `closed`;
  - total-turn cap (1 to 200, default 40);
  - the Decision record (markdown) with who wrote it and when;
  - created, updated and closed times.
- **room_participants:** room and agent, with added-by, added-at and removed-at. Removal is soft. There is at most one active row per room and agent, and at most eight active Participants per Room.
- **room_messages:**
  - room;
  - author kind `user` or `agent`, and author id;
  - body;
  - for agent Messages, the Round, the Turn and the run id;
  - a client idempotency key, unique per room.
- **rounds:**
  - room and sequence number;
  - started-by user;
  - trigger Message;
  - ask-all flag and the ordered addressed agent ids;
  - status `running`, `paused`, `stopped` or `completed`.

  At most one Round per Room may be `running` or `paused`.
- **turns:**
  - Round, agent and order;
  - status `queued`, `running` or `finished`;
  - outcome `posted`, `silent`, `failed` or `skipped`;
  - skip reason `not_invokable` or `stopped`, and the host message word for word;
  - session id, run id and the resulting Message.

  The pair (Round, agent) is unique. This is the guard that each agent gets at most one Turn per Round.
- **work_links:** room, issue, relation `created` or `linked`, who and when. The pair (room, issue) is unique.

### Routes and access

- **Mounting and auth:** all routes are plugin API routes with `board` auth. Agents never call them; an agent's Message comes from its run's reply. The host checks company access and passes the verified actor to the plugin.
- **Roles:** the plugin finds the actor's company role through the member lookup.
  - Any company member can read Rooms, transcripts, Round history and costs.
  - Any non-viewer can create a Room, post a note, and create, link or unlink follow-up work.
  - Only the Owner or a company owner or admin can:
    - start a Round;
    - Pause, Resume or Stop;
    - edit Participants, title, topic or turn cap;
    - close the Room;
    - write the Decision record.

  The single-user local board user has an owner membership, so these checks also work in local mode.
- **Route surface:**
  - list Rooms;
  - create a Room;
  - Room detail, including the active Round;
  - update a Room while idle;
  - add or remove a Participant while idle;
  - the transcript, with paging;
  - Round history with Turns and per-Turn cost;
  - costs;
  - one send endpoint;
  - Pause, Resume, Stop and close;
  - the Decision record;
  - create, link and unlink follow-up work;
  - a lookup that maps an issue to its Rooms (used by the chip).
- **The send endpoint:**
  - It saves a note, or it starts a Round when the Message has valid Participant mentions or the ask-all flag.
  - Mentions are parsed by the plugin and filtered to active Participants.
  - It returns the Message, the Round (if any) and any ignored mentions.
  - A repeated idempotency key returns the original result.
- **Errors:**
  - 409 for a second active Round, a closed Room, or a membership change during a Round.
  - 422 for too many Participants, an agent from another company, or the turn cap.
  - 403 for a role that is not allowed.
  - 404 for a Room in another company.

### Round engine

This part is carried over from the closed decision "Round engine and turn dispatch".

- **Advancing the Round:** one function advances a Round. It starts the next queued Turn only when no Turn is running and the Round is `running`. It runs:
  - when a Round starts;
  - when a Turn finishes;
  - on Resume;
  - from the sweep.
- **Turn cap:** a Round is refused when the Turns already counted, plus the new Turns, would exceed the cap. Turns skipped before their run started do not count.
- **Completion:** a Round is `completed` when every Turn has finished.
- **Retries:** none are automatic.

### Turn dispatch

- **Steps for each Turn:**
  1. Create a new agent session with the reason "Boardroom: <room title>".
  2. Send one message: the Room directive plus a bounded transcript of the latest Messages (about 12,000 characters, with a note when older Messages are left out).
  3. Store the run id from the send result.
  4. Close the session when the Turn finishes.
- **The directive gives:**
  - the topic;
  - the Participants and their roles;
  - who was addressed.

  **It tells the agent:**
  - to reply with only its Message;
  - that it may disagree;
  - not to describe its environment;
  - not to call Paperclip APIs or create work during the Turn.

  No preamble is stripped in code.
- **The reply:** the reply is the final text of the session's completion event. If that event was lost, the plugin reads the run's final summary from the runs table instead.
  - A non-empty reply becomes an agent Message, and the Turn is `posted`.
  - An empty reply makes the Turn `silent`.
  - A failed or cancelled run makes the Turn `failed`.
- **Rejected sends:** if the host rejects the send (budget, paused agent, agent not invokable), the Turn is `skipped` with reason `not_invokable` and the host message stored word for word. The plugin does not try to tell budget blocks apart, because the structured details are not reliable across the plugin connection. The Round then continues.
- **Three paths for completion,** all settling a Turn at most once:
  - the live session event;
  - the platform's run finished, failed and cancelled events;
  - a scheduled sweep every minute that reads the runs table for Turns still marked `running`, and dispatches the next Turn for Rounds that are `running` with nothing in flight.
- **Later release:** session sends also carry the Owner as the acting user, and the Room's project when it has one.

### Pause and Stop

- **Pause** marks the Round `paused`. The running Turn finishes and no new Turn starts. **Resume** marks it `running` and advances it.
- **Stop:**
  1. Mark the Round `stopped`, and mark queued Turns `skipped` with reason `stopped`.
  2. Try the host cancel for the running Turn's session.
  3. If the host does not support it, the route returns the run id and the plugin page calls the existing board route that cancels a run, as the logged-in user.
  4. If the running Turn has no run id yet (its send is still in flight), there is nothing to hand over. The route answers `fallback` without a run id on a host without the cancel, or `none` when the host has it (a host refusal then is not a failure). When the send returns into the stopped Round, the plugin tries the host cancel again and announces the Room. The page, which saw a running Turn with no run id, re-reads the Round on each Room change (or poll, kept at the active-Round rate) and cancels the run through the board route once the Turn has its id. It warns when it cannot cancel the run, or when the run ended first. A run nobody cancels settles normally and its reply is kept, as when the page's cancel fails for a known run id. (Amended 2026-10-10.)

  A cancelled run makes the Turn `failed`. A stopped Round never dispatches another Turn, even when the cancel fails. The Room stays open.

### Follow-up work and the Decision record

- **Creating work:** the plugin uses the plugin issue-creation service with:
  - origin kind `plugin:<plugin key>`;
  - origin id set to the Room id;
  - the acting user as the creator and responsible user;
  - the project defaulting to the Room's project.

  An optional plan is written as the new issue's `plan` document. A `created` work link is recorded. This drops the earlier requirement for a `manual` origin; the plugin origin is the back-link. These issues stay visible in issue lists, because only plugin operation issues are hidden.
- **Linking:** linking an existing issue of the same company records a `linked` work link, and unlinking deletes it. Both are allowed after a Room closes.
- **The "From Room" chip:** the issue page's plugin toolbar slot shows "From Room: <title>" only when a work link exists for that issue.
- **The Decision record** is a field on the Room, edited by the Owner or a company owner or admin. There is no Room issue, so there is no document for it.

### Cost

- **Where it comes from:** a SQL read of the core cost events, joined to the run ids stored on the Room's Turns and filtered by company.
- **The costs route returns:**
  - lifetime spend, tokens and run count;
  - a per-agent breakdown (spend, tokens, and Turn counts by outcome, including removed Participants);
  - Turns used against the cap.
- **Round history** carries each Turn's own cost.
- **The Room page shows** a header cost strip with a warning at 80% of the turn cap, a per-agent panel, and the cost and skip reason on each Turn.
- **Subscription billing:** on subscription billing, cost is reported in tokens with zero cents, which is shown as such.

### Audit and live updates

- **Activity entries:** every mutation writes an activity entry.
  - User actions: Room created or updated (with old and new values), Participant added or removed, Message posted, Round started, paused, resumed or stopped, Room closed, Decision recorded, and work created, linked or unlinked.
  - System entries: Turn outcomes and Round completion, with the agent and run.

  In 0.x the actor is the plugin and the acting user is in the details. The later release attributes the entry to the user.
- **Live updates:** one stream event announces any Room state change. The Room page and the list refresh from it.
- **Telemetry:** no telemetry events are added.

### UI

- A sidebar entry, and a page with a Room list and Room detail sub-routes.
- **The Room detail shows:**
  - the transcript, with Turn outcome markers;
  - the composer, with mention and "Ask all";
  - Round progress, with Pause, Resume and Stop;
  - Participants, the cost strip, and the follow-up work panel;
  - the Decision record.
- **Other UI:**
  - a creation flow with the participant picker, the optional project, the optional linked issue and the turn cap;
  - the issue-page chip.
- Errors from the plugin routes are shown, never silently ignored.

### Host additions

These are three separate pull requests to the Paperclip repo, each with its own branch and `Refs #14143`.

1. **Cancel a session run:**
   - A session `cancelRun(sessionId, companyId, { reason })`, gated by the existing session-send capability.
   - It cancels the running run and any queued turns of a session the calling plugin owns, matched by the plugin's session key prefix and the company (amended 2026-10-09).
   - It records the plugin as the canceller, so recovery does not wake the agent again.
   - It writes a cancelled activity entry with the plugin as the actor.
   - It returns the final status, or null when nothing was in flight.
2. **Attribution on session sends:** `sendMessage` gains two optional fields.
   - `actorUserId` requires the new `agent.sessions.send_human_attributed` capability. It is verified as an active human member of the company, the same way as human-attributed comments, and it becomes the requesting user.
   - `projectId` is gated by the existing send capability. It must be in the company, and it goes into the wake context so that the project budget gate applies and cost events carry the project. The run also uses that project's workspace and env, as for an issue in that project (amended 2026-10-09).

   There is no `issueId`.
3. **Attribution on activity entries:** `activity.log` gains an optional `actorUserId`.
   - It requires the new `activity.log.write_human_attributed` capability and the same membership check.
   - The entry stays a plugin action, with the verified user recorded as the initiating actor in its details (amended 2026-10-09, see ticket 12).

**Every host PR updates:**
- the shared capability list and the validator map;
- the SDK types, protocol and host client;
- the host service;
- the SDK test harness;
- the plugin authoring guide and the plugin spec.

None of them adds telemetry.

**Order:** cancel, then session attribution, then activity attribution. The second and third are independent of each other.

## Testing Decisions

- **What makes a good test:** assert behaviour a user or the host can observe. That means:
  - route responses and status codes;
  - rows a later route returns;
  - activity entries;
  - session calls made to the host;
  - what an agent received.

  Do not test the Round-advance function, the transcript builder or private helpers directly.
- **Plugin, main seam:** the plugin's API request handler, its scheduled sweep and its event handlers, run exactly as the host would call them.
  - **Host services:** the plugin SDK test harness, seeded with companies, agents and members.
  - **Database:** the harness's database client is replaced by an in-memory Postgres (PGlite) that runs the plugin's own migrations. Stub core tables hold seeded runs and cost events.
  - **Agent replies:** simulated through the harness's session events and platform events.
  - **Coverage:**
    - Room creation and the participant limit;
    - membership edits while idle versus during a Round;
    - notes versus Rounds, mentions versus "Ask all", and ignored mentions;
    - Turn order and transcript visibility within a Round;
    - each outcome;
    - rejected sends becoming `skipped`;
    - Pause, Resume and Stop, including the cancel fallback;
    - the turn cap and the second-Round conflict;
    - idempotent sends;
    - role checks for Owner, admin, operator and viewer;
    - cross-company denial;
    - follow-up work creation (origin, creator, plan, link) and linking;
    - the issue-to-Room lookup;
    - cost totals;
    - recovery after a simulated restart (a lost session event settled by the sweep, with no duplicate Turn);
    - activity entries.
- **Plugin, UI seam:** component tests of the Room page and the creation flow, with the plugin API responses mocked. They cover:
  - the participant picker;
  - mention and "Ask all" sends;
  - Round progress;
  - Pause, Resume and Stop;
  - the cost strip and the 80% warning;
  - error display.

  No end-to-end browser tests in v1.
- **Host additions seam:** the plugin host services against the embedded test database, following the existing plugin agent-sessions tests. Each PR covers:
  - ownership (another plugin's session refused);
  - capability denial;
  - a cross-company request refused;
  - a non-member or inactive user refused;
  - the unchanged behaviour when the new fields are left out.

  The cancel PR also covers the null return when nothing is running, and that recovery does not re-wake after a plugin cancel.
- **Prior art:**
  - the plugin agent-sessions server tests;
  - the plugin access-authorization host-service tests;
  - the human-attributed comment checks;
  - the plugin database tests;
  - plugins already tested through the SDK harness (the fake-sandbox plugin and the SDK's harness tests).

  No plugin test uses a real database yet, so the PGlite swap is new.
- **Before hand-off:**
  - **Plugin repo:** its own typecheck, tests and build, plus a manual check on a local Paperclip instance with one real agent.
  - **Host PRs:** the Paperclip repo's required typecheck, tests and build, a green CI, and the Greptile review required by the contributing guide.

## Out of Scope

- Agent-to-agent autonomous continuation beyond a Round the Owner started.
- Room-scoped dollar budgets and hard stops (a new budget scope type).
- Summarization or compaction of long Rooms.
- Water Cooler (ambient agent chat).
- Restoring the discussion-room endpoints of issue #12599. Nothing of them exists, so this is a fresh design.
- Bridging Rooms to Slack, Discord, Teams or other external chat channels.
- Agents opening Rooms or calling Boardroom routes.
- Requesting approvals from a Room.
- Requiring an outcome before a Room can close.
- An `issueId` on session sends.
- Telemetry events.
- Bundling the plugin into the Paperclip repo.
- Any Boardroom-specific code in Paperclip core.

## Further Notes

- **Map status:** every decision on the map is closed. The detail behind each decision lives in its map ticket, and this spec summarises them. It supersedes the core spec, which is kept for reference.
- **Spike evidence:**
  - A plugin session wake on the Claude local adapter answered the question rather than running the heartbeat routine.
  - It recorded a run id and agent cost.
  - It replied with a preamble, which is why the directive asks for only the Message.

  It was not verified on other adapters. Check at least one other adapter during the manual test.
- **Contribution process:**
  - The contributor did the Discord `#dev` pitch.
  - Host PRs follow the contributing guide strictly: clear commits, public references only, descriptive kebab-case branches, the full PR template in Simplified Technical English including Thinking Path and Model Used, and no lockfile commits.
  - Nothing has been posted upstream from this planning work.
- **Tracker:** no issue tracker is configured, so this spec lives in the local untracked map folder, with the `ready-for-agent` label in its front matter. It moves into the plugin repository when that repository is created.
- **Promotion:** the glossary and ADR 0002 move into the plugin repository with this spec.
