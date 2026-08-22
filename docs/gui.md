# Desktop GUI

The Electron desktop app shares the same `core/` logic and `~/.fungible/` data as the TUI. All ten screens are present (Dashboard, Transactions, Trends, Net Worth, Accounts, Tags, Rules, Health, Canvas, Settings) plus a chat drawer for the agent.

The GUI does **not** start the MCP or HTTP API servers in the background — if you want them running alongside the desktop app, launch them separately with `fungible mcp` or `fungible api`.

## Install

### From a release

Download an installer from the [latest GitHub Release](https://github.com/tomfunk/fungible/releases/latest):

- **macOS (Apple Silicon)** — `fungible-<version>-mac-arm64.dmg`
- **Windows (x64)** — `fungible-<version>-win-x64.exe`
- **Linux (x64)** — `fungible-<version>-linux-x86_64.AppImage` or `.deb`

The installers are ad-hoc signed, not notarized (no paid Apple Developer ID). On first launch:

- **macOS** — Gatekeeper blocks it with "Apple could not verify 'Fungible' is free of malware". Open it once from System Settings → Privacy & Security → "Open Anyway", or run `xattr -dr com.apple.quarantine /Applications/Fungible.app`.
- **Windows** — SmartScreen may warn; click "More info" → "Run anyway".
- **Linux AppImage** — `chmod +x` the file, then run it.

On releases up to v1.8.0 the macOS app shipped unsigned, so Gatekeeper rejected it outright with "Fungible is damaged and can't be opened" and offered no "Open Anyway" (issue [#144](https://github.com/tomfunk/fungible/issues/144)). The `xattr -dr` command above clears that too; upgrading is the better fix.

### From source

Requires Node.js 22+.

```bash
git clone https://github.com/tomfunk/fungible
cd fungible
npm install
npm run gui
```

## Demo mode

Demo mode runs against an isolated, pre-seeded dataset at `~/.fungible-demo/` — your real data is untouched. Three ways in:

- **In the app** — fungible menu (macOS) or Help menu (Windows/Linux) → "Try Demo Mode". The app relaunches with demo data; "Leave Demo Mode" switches back.
- **Packaged binary** — pass `--demo`, e.g. `/Applications/Fungible.app/Contents/MacOS/Fungible --demo`.
- **From source** — `npm run gui:demo`.

The demo database is seeded with fake accounts and transactions on first launch. Background sync and backups are disabled in demo mode.

## Packaging locally

Builds installers for the current platform (or any platform — cross-compile works from macOS, with the usual caveats for code-signing):

```bash
npm run gui:dist:mac     # dmg + zip (arm64)
npm run gui:dist:win     # nsis installer (x64)
npm run gui:dist:linux   # AppImage + deb (x64)
```

Output lands in `release/`. Config is in `electron-builder.yml`. The libsql native binding is in `asarUnpack` so it can `dlopen` from disk; `@noble/hashes` is pinned via `overrides` because v2 went ESM-only and broke `app-builder-lib`'s CJS require.

## Release flow

Installers for tagged releases are built and attached automatically by `.github/workflows/release.yml` whenever something merges into `main`. The release flow is `feature → dev → main`; see [CONTRIBUTING.md](../CONTRIBUTING.md) for the branching policy.

## Data location

Same as the TUI: `~/.fungible/` (or `$FUNGIBLE_DATA_DIR` if set). The GUI reads and writes the same SQLite database, so you can switch between TUI and GUI freely without any data migration.
