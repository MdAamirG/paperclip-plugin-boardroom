# Boardroom

A deliberate, human-led discussion between a board operator and explicitly chosen agents, scoped to one decision or problem, that resolves into ordinary Paperclip work.

## Language

**Boardroom**:
The feature: multi-agent, human-led discussion rooms. Distinct from Conference Room (single concierge chat) and Agent Chat (one human, one agent).
_Avoid_: group chat, water cooler, channel

**Room**:
One durable discussion about a single topic, owned by a board operator, with a set of Participants that the board can edit between Rounds.
_Avoid_: thread, channel, chat

**Participant**:
An agent explicitly added to a Room. Only Participants can be addressed or take Turns.
_Avoid_: member, attendee

**Owner**:
The board user who created a Room and controls it: starts, pauses and stops Rounds, edits Participants, closes the Room and records its Decision record. Company owners and admins have the same control. Any company member can read a Room and any non-viewer can post; the Owner is not a Participant.
_Avoid_: host, moderator

**Message**:
A durable, author-attributed contribution to a Room by the Owner, another board user, or a Participant.
_Avoid_: post, comment

**Round**:
One human-initiated pass in which each addressed agent gets at most one Turn, after which control returns to the human.
_Avoid_: cycle, iteration

**Turn**:
A single agent run that reads the Room and posts at most one Message.
_Avoid_: wakeup, reply

**Follow-up work**:
An ordinary issue created from a Room (with an optional plan) or an existing issue linked to it. Either way the issue shows that it came from the Room.
_Avoid_: output, action item

**Decision record**:
The outcome the Owner writes down on a Room: what was decided and why. It belongs to the Room, not to any issue.
_Avoid_: summary, minutes
