# Testing

Tests use [Vitest](https://vitest.dev/). No external services are needed: the database is in-memory libsql, and Plaid and LLM calls are faked.

## Running

Node 22 or newer is required (`nvm use 22`); older versions fail spuriously.

```bash
npm test                 # all unit/integration tests, once
npm run test:watch       # watch mode
npm run test:coverage    # coverage report in ./coverage (reporting only, no threshold)
npm run test:e2e         # builds the Electron app, then runs Playwright
```

`test:e2e` needs a working Electron build (it runs `electron-vite build` first). Specs live in `tests/e2e/`.

## Layout

| Where | What |
| --- | --- |
| `tests/*.test.ts` | core, MCP, API, GUI bridge registry |
| `tests/tui/` | Ink screens |
| `tests/gui/` | React renderer screens |
| `tests/e2e/` | Playwright smoke specs |
| `tests/helpers/` | shared helpers (below) |

## Kinds of test

**A. Pure unit.** Money math, dates, `fmt`, calculators. Plain inputs, plain outputs, no DB. Assert values, including edge cases (zero, negative, month boundaries).

**B. Table-driven rules.** Categorization, tag rules, amount parsing: one `it.each` table of input and expected result. Add a row, not a new test.

**C. DB integration.** Use `makeTestDb()` for a real in-memory database. Assert the persisted rows, never the SQL text.

**D. External boundary.** Plaid and LLM calls go through `makeFakePlaid` / `makeFakeLlm` (`tests/helpers/makeFakeProvider.ts`): scripted responses, including `Error`s. Test how our code handles the response (pagination, failure, retry), not the fake.

**E. Surface contract.** MCP tools, API routes and the GUI bridge registry. Assert the contract: schema in, shape out, and the error shape on bad input. Business logic belongs in A to C.

**F. TUI render and keypress.** `ink-testing-library`: write keys to `stdin`, then `waitFor` the result. Assert text unique to the new state ("3 selected", a saved name), not layout, colour, or labels that are always on screen (a header proves nothing).

**G. GUI component.** Render with the real registry (`tests/gui/helpers/renderGui.tsx`), act through the UI, then assert DB rows and visible text. Prefer roles and ARIA (`getByRole`) over CSS class names.

**H. Parity.** `tests/gui-bridge-parity.test.ts` fails when a core capability used by a TUI screen is not exposed to the GUI (or explicitly listed as exempt). If you add a core function a screen uses, expose it or record why not.

**I. e2e smoke.** Does the app launch and do the screens render? Never logic; that is covered above, faster.

**J. Incident regression.** When something breaks in real use, add a test named after the incident (`it('does not double-count a pending charge once it posts')`) at the lowest level that reproduces it.

## Rules

- **Bug fixes get a failing-first test.** Write it, watch it fail for the right reason, then fix.
- **Don't test the mock.** If the assertion would pass with the real code deleted, it proves nothing.
- **Extend a table before adding a near-duplicate file.**
- **Use the shared helpers** instead of copy-pasting setup.
- **Anything date-dependent uses `useFixedClock`.** Never depend on today's date.

## Shared helpers (`tests/helpers/`)

| Helper | Use |
| --- | --- |
| `makeTestDb` | fresh in-memory DB with the schema |
| `schema-drift.test.ts` | guards `makeTestDb`'s schema against the real `initDb()` schema; if it fails, update the helper |
| `fakeClock` (`useFixedClock`) | pins `Date` (default `2026-10-02T12:00:00Z`); call at describe or file top level |
| `waitFor`, `waitForFrame`, `pressAndWait`, `frame`, `flatFrame`, `stripAnsi` | async polling and frame text for Ink tests |
| `tempCsv` (`useTempCsv`) | temp directory for CSV import tests, cleaned up automatically |
| `makeFakeProvider` | `makeFakePlaid`, `makeFakeLlm` |
| `makeAccount`, `makeCsvRow`, `makeHealthData`, `balanceFixtures`, `seedTuiData` | fixtures for common shapes |
| `ansi` | forced colour helpers, for the rare test where colour is the behaviour |

Screen-test setup lives in `tests/tui/helpers/screenSetup.tsx` and `tests/gui/helpers/renderGui.tsx`.
