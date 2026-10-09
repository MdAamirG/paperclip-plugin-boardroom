# Releasing 0.1.0

This is a checklist. Nothing in it has been performed. Do not publish, tag or post until each step is done on purpose, by the person who owns the npm account.

## Before publishing

- [ ] Work from a clean clone on `main`, with a clean tree (`git status` shows nothing).
- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] `npm pack --dry-run` lists only `dist/`, `migrations/`, `README.md`, `LICENSE` and `package.json`.
- [ ] `docs/manual-check-0.1.0.md` is filled in: every one of the 13 steps passed or failed, with the Paperclip version, the adapters used (at least one besides `claude_local`) and run ids. Every failure is named as a follow-up or fixed.
- [ ] The host assumptions listed in that file are confirmed or recorded as known limits in the README.
- [ ] The version is `0.1.0` in `package.json` and `src/manifest.ts`; `CHANGELOG.md` has the date for 0.1.0 instead of "Unreleased"; the README says it is published only once it is.
- [ ] `npm whoami` shows the intended npm account. The package name is `paperclip-plugin-boardroom` (unscoped) or under the account's own scope. Never publish under `@paperclipai/`.

## Publish

- [ ] `npm publish` from the clean tree, under your npm account (add `--access public` if you use a scope).
- [ ] Tag the released commit: `git tag v0.1.0` and push the tag.

## After publishing

- [ ] Install from npm into a scratch Paperclip instance and confirm the Boardroom entry appears.
- [ ] Post the repository link on Paperclip issue #14143.
