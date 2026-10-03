# Contributing to fungible

Thanks for your interest in contributing. This document covers how to get set up, run tests, and submit changes.

## Setup

Requires Node.js 22+.

```bash
git clone https://github.com/tomfunk/fungible
cd fungible
npm install
```

Run the app in dev mode:

```bash
npm run dev
```

On first run, use `--setup` to configure Plaid credentials. For development without a bank connection, use demo mode:

```bash
npm run demo
```

## Running tests

```bash
npm test           # run all tests once
npm run test:watch # watch mode
npm run typecheck  # TypeScript type check only
```

Tests use [Vitest](https://vitest.dev/) with an in-memory SQLite database — no external services needed.

## Project structure

```
core/         Business logic: queries, rules, categorization, date utils
tui/          Terminal UI (React/Ink components, one file per screen)
mcp/          MCP server — exposes tools to Claude
api/          HTTP API server (same tools as MCP, over REST)
tests/        Tests: core at the top level, tui/, gui/ and e2e/ in subfolders (see docs/testing.md)
scripts/      CLI scripts: CSV import, Plaid link, rule seeding
bin/          Entry point for the fungible CLI
```

## Making changes

### Branches

The repo uses a two-tier flow:

- `dev` is the integration branch — all feature/fix work merges here.
- `main` is the release branch. Every merge into `main` cuts a new version tag, builds installers, and updates the Homebrew formula. Only `dev` can PR into `main` (enforced by CI), so `main` only ever advances via `dev → main` release promotions.

**Open your PR against `dev`, not `main`.**

Use a descriptive branch name prefixed by type:

```
feat/short-description
fix/short-description
docs/short-description
chore/short-description
```

### Tests

- Tests ship with the change. Bug fixes get a failing-first test.
- Query-level logic should have test coverage in `tests/queries.test.ts` (or the relevant test file)
- Tests use a shared in-memory DB initialized via `tests/helpers/makeTestDb.ts`
- Follow the existing `insertTx` / `describe` + `it` pattern
- **Any new interactive feature in a TUI screen must have a test in that screen's file, `tests/tui/<screen>.test.tsx`,** that simulates the key press and asserts on the rendered output. This catches bugs like unawaited async calls that only surface at runtime. Use the `waitFor` helper and `r.stdin.write(key)` to simulate user input.
- See [`docs/testing.md`](docs/testing.md) for the kinds of test, what each should assert, and the shared helpers.

### Version bump

Manual version bumps are not necessary.  We loosely follow [semver](https://semver.org/): we use patches for fixes and features which don't require changes to the database schema, minor versions are required for things that change the database.  Our release workflow computes this so you don't need to change the version in `package.json`.

## Opening an issue

Before opening an issue, check if one already exists. When filing a bug, include your OS, Node version, and steps to reproduce. For feature requests, a short description of the use case is enough — no need for a full spec.

## Submitting a PR

1. Fork the repo and push your branch to your fork
2. Open a PR against `dev` (PRs against `main` are rejected by CI — only `dev → main` release promotions land there)
3. Make sure `npm test` and `npm run typecheck` pass, and that the change includes its tests
4. Include a short description of what changed and why

## License

MIT. By contributing you agree your changes will be licensed under the same terms.
