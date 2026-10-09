# Manual check, 0.1.0

Status: **not run**. Nothing below has been performed. Fill this in on a throwaway local Paperclip instance (current release, `local_trusted` mode, embedded database, scratch data directory and its own instance name), with the plugin installed from its local path, not on a working company.

- Paperclip version: _not run_
- Plugin commit: _not run_
- Adapters used (at least `claude_local` x2 and one other, for example `codex_local`): _not run_

Record each step as passed or failed, with run ids. Name any failure as a follow-up.

| # | Step | Status | Run ids and notes |
| --- | --- | --- | --- |
| 1 | Before install, no Boardroom entry. After install and enable, the sidebar entry appears; after disable it disappears and the routes return 404 or 503. | not run | |
| 2 | Create a Room with two agents on `claude_local` and one on a second adapter, a project and a linked issue. | not run | |
| 3 | Post a note: no run starts. | not run | |
| 4 | Mention one agent: one run, a posted Message, cost shown on the Turn. The reply has no environment preamble. | not run | |
| 5 | "Ask all": serial Turns; the second agent's reply can refer to the first. | not run | |
| 6 | Pause and Resume during a Round; Stop during a Turn (fallback cancel through the board route). The run shows as cancelled in Paperclip and no further Turn starts. | not run | |
| 7 | Pause an agent in Paperclip, then address it: the Turn is skipped with Paperclip's message. | not run | |
| 8 | Restart the Paperclip server during a Turn: the Round settles and continues within about a minute, with no duplicate Message. | not run | |
| 9 | Record a Decision; create follow-up work with a plan; link an existing issue; open the issue and see the "From Room" chip; the issue is in the issue list and the Room is not. | not run | |
| 10 | Close the Room; a note is refused; follow-up work can still be created. | not run | |
| 11 | Check the activity log for the Room's entries. | not run | |
| 12 | A viewer account (if the instance mode has one) can read but not post. | not run | |
| 13 | The agents' own permissions and budgets applied during Turns, and no agent created work or called Paperclip APIs during a Turn. | not run | |

## Adapters that answered with their heartbeat routine instead of the question

_not run_ (record the adapter and run id for each)

## Host assumptions to confirm during the check

These were assumed in the build from host source and the spec and are not verified on a running host. Record the result next to the step that exercises them.

- [ ] (step 4, 5) The plugin receives `agent.run.finished|failed|cancelled` events for runs it started itself.
- [ ] (step 4) Cost events are recorded on the run id that the session send returns, so cost shows on the Turn (not zeros).
- [ ] (step 8) `heartbeat_runs.result_json.summary` is not truncated in a way that shortens a recovered reply.
- [ ] (step 6) `POST /api/heartbeat-runs/:id/cancel` works as the board user, and the run shows as cancelled. Also note whether the host offers the session-run cancel.
- [ ] (step 9) `actor.actorUserId` on task creation is honoured: open the created task and confirm creator, responsible user, origin and the `plan` document.
- [ ] (step 9) The host renders the `toolbarButton` "From Room" chip on the issue page with the issue as `entityId`; check its placement.
- [ ] (steps 2 to 10) Look and feel: light and dark themes, a narrow screen (single column below 64rem), transcript scroll-follow, mention list position, Turn marker placement and hints.
- [ ] (step 9) The real Markdown editor in the Decision record: Edit, Cancel/Save layout, Ctrl+Enter.
- [ ] (step 11) Activity entries are attributed to the plugin with the acting user in their details.
- [ ] (step 1) In `local_trusted` mode the local board user has a company membership (otherwise the API answers 403 `not_a_company_member` until a host restart).

## Follow-ups

_none recorded (check not run)_
