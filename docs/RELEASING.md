# Releasing 0.1.0

This is a checklist. The "Before publishing" items were checked on 2026-10-11 from a clean clone of `main`. Publish and After publishing have not been performed. Do not publish, tag or post until each step is done on purpose, by the person who owns the npm account.

## Before publishing

- [x] Work from a clean clone on `main`, with a clean tree (`git status` shows nothing).
- [x] `pnpm install --frozen-lockfile`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`
- [x] `npm pack --dry-run` lists only `dist/`, `migrations/`, `README.md`, `LICENSE` and `package.json`.
- [x] `docs/manual-check-0.1.0.md` is filled in: every one of the 13 steps passed or failed, with the Paperclip version, the adapters used (at least one besides `claude_local`) and run ids. Every failure is named as a follow-up or fixed. (Step 12, the viewer account, is recorded as not verified because `local_trusted` has no viewer; the README lists it under Known limits.)
- [x] The host assumptions listed in that file are confirmed or recorded as known limits in the README.
- [x] The version is `0.1.0` in `package.json` and `src/manifest.ts`; `CHANGELOG.md` has the date for 0.1.0 instead of "Unreleased"; the README says it is published only once it is.
- [x] `npm whoami` shows the intended npm account. The package name is `paperclip-plugin-boardroom` (unscoped) or under the account's own scope. Never publish under `@paperclipai/`.

## Publish

- [ ] `npm publish` from the clean tree, under your npm account (add `--access public` if you use a scope).
- [ ] Tag the released commit: `git tag v0.1.0` and push the tag.

## After publishing

- [ ] Install from npm into a scratch Paperclip instance and confirm the Boardroom entry appears.
- [ ] Post the repository link on Paperclip issue #14143.
