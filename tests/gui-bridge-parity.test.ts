import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Feature-parity guard: every core function a TUI screen uses must either be
 * exposed through the GUI bridge registry, be importable directly by the
 * renderer (pure modules), or be explicitly listed below as pending/handled.
 * When a TUI screen gains a new core capability, this test fails until the
 * GUI accounts for it.
 */

// Pure modules the renderer imports directly — no bridging needed.
const PURE_MODULES = new Set(['fmt', 'dateUtils', 'filters', 'canvas-spec', 'account-class']);

// TUI files that are out of GUI scope.
const SKIP_FILES = new Set(['Setup.tsx', 'index.tsx']);

// name → why it's not in the registry (yet). Shrinks as GUI phases land.
const EXPECTED_UNBRIDGED: Record<string, string> = {
  // Handled differently in the GUI
  parseCSV: 'covered by files.pickCsv (native dialog + parse in main)',
  parseDate: 'CSV preview shows raw values; real parsing happens during import in main',
  householdMembers: 'exposed as profile.getHouseholdMembers',
  spawn: 'node builtin used by TUI Plaid flow; GUI will use gui/main/plaid-link.ts',
  onRefresh: 'main process subscribes and pushes refresh events over IPC (gui/main/refresh-ipc.ts)',
  generateAllPeriods: 'imported but unused by tui/Trends.tsx; GUI uses getPeriodTotals',

  // Agent chat is wired through dedicated IPC channels (gui/main/agent-ipc.ts)
  runAgentTurn: 'gui/main/agent-ipc.ts agent:run channel',
  detectProvider: 'gui/main/agent-ipc.ts agent:provider channel',
  getProviderModel: 'gui/main/agent-ipc.ts agent:provider channel',

  // Pure canvas helpers — renderer imports core/canvas-spec.ts directly
  evalExpr: 'renderer imports pure core/canvas-spec.ts directly',
  fmtValue: 'renderer imports pure core/canvas-spec.ts directly',
  fmtDialValue: 'renderer imports pure core/canvas-spec.ts directly',

  // Pure scorecard helpers — renderer imports core/scorecard.ts directly (GUI PR2)
  bucketDrift: 'renderer imports pure core/scorecard.ts directly',
  isSignificantDelta: 'renderer imports pure core/scorecard.ts directly',
  ratioLabel: 'renderer imports pure core/scorecard.ts directly',

  // Electron-side bridge namespaces live in gui/main/bridge.ts (not registry.ts)
  getDefaultDaysRequested: 'bridge plaid namespace (gui/main/bridge.ts)',

  // Pure error-formatting helper — the GUI surfaces Plaid sync errors its own way
  plaidErrorMessage: 'pure helper; GUI formats sync errors in its own layer',

  // Session-only sync-failure store (core/sync-status.ts) — the GUI will surface
  // sync status in its own layer (renderer state), not through the bridge.
  setSyncResult: 'GUI will surface sync status in its own layer',
  mergeSyncResult: 'GUI will surface sync status in its own layer',
  // Pure formatter for syncAll's onProgress steps. The callback itself can't
  // cross the IPC bridge, so the GUI would push progress over a channel and
  // format it renderer-side rather than calling this through the registry.
  describeSyncProgress: 'progress callback cannot cross IPC; GUI will push steps over its own channel',
  getSyncFailures: 'GUI will surface sync status in its own layer',
  onSyncStatus: 'GUI will surface sync status in its own layer',

  // The GUI bridges the composed action (sync.deleteCursorAndResync) rather than
  // the bare cursor delete. On its own it leaves the item mid-operation until
  // something resyncs, so main runs both steps together where they cannot be
  // interleaved with another sync.
  deleteSyncCursor: 'GUI bridges the composed sync.deleteCursorAndResync instead',

  // On-demand /transactions/refresh (core/transactions-refresh.ts) — bridged, but
  // not through the registry: the poll runs for minutes and streams progress, so
  // it has a dedicated channel (gui/main/sync-ipc.ts, 'sync:refresh') with a
  // progress push and a cancel path rather than a single request/response call.
  refreshTransactions: 'bridged via sync-ipc streaming channel, not the registry',
  describeRefreshProgress: 'renderer imports it directly to format pushed progress steps',
  describeRefreshResult: 'renderer imports it directly to format the final result',

  // Generic settings access — GUI uses typed wrappers (settings.getPretaxMonthly /
  // settings.setPretaxMonthly) rather than the raw getSetting/setSetting functions.
  getSetting: 'GUI exposes typed wrappers (getPretaxMonthly/setPretaxMonthly) via settings namespace instead of generic access',
  setSetting: 'GUI exposes typed wrappers (getPretaxMonthly/setPretaxMonthly) via settings namespace instead of generic access',
};

function collectTuiCoreImports(): Map<string, string[]> {
  const tuiDir = join(import.meta.dirname, '../tui');
  const found = new Map<string, string[]>(); // name → files using it
  const importRe = /import\s*(type\s*)?{([^}]+)}\s*from\s*'\.\.\/core\/([\w-]+)\.js'/g;

  for (const file of readdirSync(tuiDir)) {
    if (!file.endsWith('.tsx') || SKIP_FILES.has(file)) continue;
    const src = readFileSync(join(tuiDir, file), 'utf-8');
    for (const m of src.matchAll(importRe)) {
      const [, typeOnly, names, module] = m;
      if (typeOnly || PURE_MODULES.has(module)) continue;
      for (const rawName of names.split(',')) {
        const name = rawName.trim();
        if (!name || name.startsWith('type ')) continue;
        const clean = name.split(/\s+as\s+/)[0].trim();
        if (/^[A-Z0-9_]+$/.test(clean)) continue; // constants — renderer mirrors or ignores
        found.set(clean, [...(found.get(clean) ?? []), file]);
      }
    }
  }
  return found;
}

describe('GUI bridge feature parity with TUI', () => {
  let registryNames: Set<string>;

  beforeAll(async () => {
    process.env.FUNGIBLE_DATA_DIR = mkdtempSync(join(tmpdir(), 'fungible-parity-'));
    const { registry } = await import('../gui/main/registry.js');
    registryNames = new Set(
      Object.values(registry).flatMap((ns) => Object.keys(ns as Record<string, unknown>)),
    );
  });

  it('every core function used by a TUI screen is bridged or accounted for', () => {
    const tuiImports = collectTuiCoreImports();
    const missing: string[] = [];
    for (const [name, files] of tuiImports) {
      if (registryNames.has(name)) continue;
      if (name in EXPECTED_UNBRIDGED) continue;
      missing.push(`${name} (used by ${[...new Set(files)].join(', ')})`);
    }
    expect(
      missing,
      `TUI uses core functions the GUI bridge does not expose. Either add them to gui/main/registry.ts or record them in EXPECTED_UNBRIDGED with a reason:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('EXPECTED_UNBRIDGED has no stale entries', () => {
    const stale = Object.keys(EXPECTED_UNBRIDGED).filter((name) => registryNames.has(name));
    expect(
      stale,
      `These are now bridged — remove them from EXPECTED_UNBRIDGED:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });
});
