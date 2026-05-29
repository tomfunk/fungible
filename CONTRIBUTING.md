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
tests/        Test files, mirroring the core/ structure
scripts/      CLI scripts: CSV import, Plaid link, rule seeding
bin/          Entry point for the fungible CLI
```

## Making changes

### Branches

Use a descriptive branch name prefixed by type:

```
feat/short-description
fix/short-description
docs/short-description
chore/short-description
```

### Adding a new MCP tool

Tools are defined in three places — keep them in sync:

1. `core/queries.ts` — the database query
2. `core/tools.ts` — `TOOL_DEFS` entry + `executeTool` case
3. `mcp/server.ts` — `server.tool(...)` registration with Zod schema

### Tests

- Query-level logic should have test coverage in `tests/queries.test.ts` (or the relevant test file)
- Tests use a shared in-memory DB initialized via `tests/helpers/makeTestDb.ts`
- Follow the existing `insertTx` / `describe` + `it` pattern

### Version bump

Every PR that changes behavior (features, fixes, tool additions) must bump the version in `package.json`. Follow [semver](https://semver.org/): patch for fixes, minor for new features. The CI version bump check will fail if this is missing.

## Submitting a PR

1. Fork the repo and push your branch to your fork
2. Open a PR against `main`
3. Make sure `npm test` and `npm run typecheck` pass
4. Include a short description of what changed and why

## License

MIT. By contributing you agree your changes will be licensed under the same terms.
