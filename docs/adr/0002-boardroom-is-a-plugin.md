---
status: accepted (supersedes ADR 0001)
---
# The Boardroom is a plugin, with Rooms and Messages in plugin-owned tables

CONTRIBUTING.md asks contributors to prefer the plugin system when a feature fits as an extension, and doc/PRODUCT.md puts optional chat surfaces in plugins so core stays task-and-comment centric. Research showed a plugin can provide almost all of the Boardroom (own tables, authenticated company-scoped routes, a page and sidebar entry, agent sessions that return replies, cost reads by run id). So the Boardroom is built as a plugin, and Rooms and Messages live in plugin tables instead of an issue and its comments (ADR 0001). The only core changes are small, generic plugin-host additions that are not Boardroom-specific. Considered: building in core (ADR 0001), which keeps issue-based attribution but adds a chat surface to the control plane, against the product docs.
