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

## Repository layout

- `src/manifest.ts`, `src/worker.ts`, `src/ui/`: the plugin.
- `migrations/`: SQL migrations the host applies to the plugin's database namespace, in filename order. Qualify every object with the host-derived schema name `plugin_boardroom_79f8e138fc`.
- `tests/`: worker tests (`*.spec.ts`) and UI tests (`*.spec.tsx`). `tests/support/` holds the test harness.
- `docs/`: the spec, the glossary (`CONTEXT.md`) and the architecture decision records.
