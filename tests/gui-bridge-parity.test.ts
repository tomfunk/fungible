import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from '@babel/parser';

/**
 * Feature-parity guard: every core function a TUI screen uses must either be
 * exposed through the GUI bridge registry, be importable directly by the
 * renderer (pure modules), or be explicitly listed below as pending/handled.
 * When a TUI screen gains a new core capability, this test fails until the
 * GUI accounts for it.
 *
 * Imports are read with a real parser, @babel/parser (not a regex; typescript v7 has no JS compiler API), so default,
 * namespace, aliased, multi-line and `export ... from` forms are all seen,
 * `import type` / `{ type X }` are ignored, and names re-exported through
 * barrels (e.g. core/canvas-agent.ts -> canvas-spec.ts) are attributed to the
 * module that really defines them.
 */

const ROOT = resolve(import.meta.dirname, '..');
const CORE = join(ROOT, 'core');

// ── import parsing ───────────────────────────────────────────────────────────

/** One value import/re-export from a module specifier. name: exported name, 'default', or '*' (namespace used as a whole value). */
type RawImport = { specifier: string; name: string };

type ReadSource = (absPath: string) => string | undefined;

const realRead: ReadSource = (p) => (existsSync(p) && statSync(p).isFile() ? readFileSync(p, 'utf-8') : undefined);

// Loose node shape: we only touch a handful of well-known Babel AST fields.
type N = { type: string; [k: string]: any };

function parseSource(src: string, fileName: string): N {
  return parse(src, {
    sourceType: 'module',
    plugins: fileName.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
  }).program as unknown as N;
}

const nameOf = (n: N): string => (n.type === 'StringLiteral' ? n.value : n.name);

function walk(node: unknown, visit: (n: N) => boolean | void): void {
  if (Array.isArray(node)) { for (const c of node) walk(c, visit); return; }
  if (!node || typeof node !== 'object' || typeof (node as N).type !== 'string') return;
  if (visit(node as N) === false) return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'loc' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
    walk(v, visit);
  }
}

/** All value imports in a source: named (original name, aliases resolved), default, namespace (property accesses), plus `export {..} from` / `export * from`. Type-only forms are ignored. */
function parseImports(src: string, fileName: string): RawImport[] {
  const program = parseSource(src, fileName);
  const out: RawImport[] = [];
  const namespaces = new Map<string, string>(); // local identifier → specifier
  for (const st of program.body as N[]) {
    if (st.type === 'ImportDeclaration') {
      if (st.importKind === 'type' || st.importKind === 'typeof') continue;
      const spec = st.source.value as string;
      for (const sp of st.specifiers as N[]) {
        if (sp.type === 'ImportDefaultSpecifier') out.push({ specifier: spec, name: 'default' });
        else if (sp.type === 'ImportNamespaceSpecifier') namespaces.set(sp.local.name, spec);
        else if (sp.importKind !== 'type' && sp.importKind !== 'typeof') out.push({ specifier: spec, name: nameOf(sp.imported) });
      }
    } else if (st.type === 'ExportNamedDeclaration' && st.source) {
      if (st.exportKind === 'type') continue;
      for (const sp of st.specifiers as N[]) {
        if (sp.type === 'ExportSpecifier' && sp.exportKind !== 'type') out.push({ specifier: st.source.value, name: nameOf(sp.local) });
      }
    } else if (st.type === 'ExportAllDeclaration') {
      if (st.exportKind !== 'type') out.push({ specifier: st.source.value, name: '*' });
    }
  }
  // Namespace imports: attribute `ns.foo` accesses to foo; any other use of ns is '*'.
  if (namespaces.size) {
    walk(program.body, (n) => {
      if (n.type === 'ImportDeclaration') return false;
      if (n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && namespaces.has(n.object.name)) {
        out.push({ specifier: namespaces.get(n.object.name)!, name: n.property.name });
        return false;
      }
      if (n.type === 'Identifier' && namespaces.has(n.name)) out.push({ specifier: namespaces.get(n.name)!, name: '*' });
    });
  }
  return out;
}

/** Specifier → absolute .ts/.tsx path (relative specifiers only; `.js` maps to its TS source). */
function resolveSpecifier(specifier: string, fromFile: string, read: ReadSource): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  const stem = base.replace(/\.(js|jsx)$/, '');
  for (const cand of [`${stem}.ts`, `${stem}.tsx`, join(stem, 'index.ts'), base]) {
    if (read(cand) !== undefined) return cand;
  }
  return undefined;
}

type Origin = { file: string; name: string };

/** True when `file` itself declares an export called `name` (function/class/const or local `export { name }`). */
function declaresExport(file: string, name: string, read: ReadSource): boolean {
  const src = read(file);
  if (src === undefined) return false;
  for (const st of parseSource(src, file).body as N[]) {
    if (st.type !== 'ExportNamedDeclaration' || st.source) continue;
    const d = st.declaration as N | null;
    if (d && (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id?.name === name) return true;
    if (d && d.type === 'VariableDeclaration' && d.declarations.some((x: N) => x.id.type === 'Identifier' && x.id.name === name)) return true;
    if (!d && st.exportKind !== 'type' && st.specifiers.some((sp: N) => nameOf(sp.exported) === name)) return true;
  }
  return false;
}

/** Follow re-exports (`export {a as b} from`, `export * from`, recursively) to the module that defines `name`. */
function resolveOrigin(file: string, name: string, read: ReadSource, seen = new Set<string>()): Origin {
  const key = `${file}::${name}`;
  if (seen.has(key)) return { file, name };
  seen.add(key);
  const src = read(file);
  if (src === undefined) return { file, name };
  const stars: string[] = [];
  const body = parseSource(src, file).body as N[];
  // `import { x } from './y.js'; export { x };` re-exports through a local binding.
  const bound = new Map<string, { specifier: string; name: string }>();
  for (const st of body) {
    if (st.type !== 'ImportDeclaration' || st.importKind === 'type') continue;
    for (const sp of st.specifiers as N[]) {
      if (sp.type === 'ImportSpecifier' && sp.importKind !== 'type') bound.set(sp.local.name, { specifier: st.source.value, name: nameOf(sp.imported) });
    }
  }
  for (const st of body) {
    if (st.type === 'ExportNamedDeclaration' && !st.source && !st.declaration && st.exportKind !== 'type') {
      for (const sp of st.specifiers as N[]) {
        const b = bound.get(nameOf(sp.local));
        const target = b && resolveSpecifier(b.specifier, file, read);
        if (b && target && sp.exportKind !== 'type' && nameOf(sp.exported) === name) return resolveOrigin(target, b.name, read, seen);
      }
    }
    if (st.type === 'ExportAllDeclaration' && st.exportKind !== 'type') {
      const target = resolveSpecifier(st.source.value, file, read);
      if (target) stars.push(target);
    } else if (st.type === 'ExportNamedDeclaration' && st.source && st.exportKind !== 'type') {
      const target = resolveSpecifier(st.source.value, file, read);
      if (!target) continue;
      for (const sp of st.specifiers as N[]) {
        if (sp.exportKind !== 'type' && nameOf(sp.exported) === name) return resolveOrigin(target, nameOf(sp.local), read, seen);
      }
    }
  }
  if (declaresExport(file, name, read)) return { file, name };
  for (const target of stars) {
    const o = resolveOrigin(target, name, read, seen);
    if (declaresExport(o.file, o.name, read)) return o;
  }
  return { file, name };
}

type CoreUse = { name: string; originFile: string; specifier: string; file: string };

/** Every value import in `src` that resolves into core/, attributed to its defining module. */
function coreUsesInSource(src: string, fileName: string, read: ReadSource, coreDir = CORE): CoreUse[] {
  const uses: CoreUse[] = [];
  for (const imp of parseImports(src, fileName)) {
    const target = resolveSpecifier(imp.specifier, fileName, read);
    if (!target || !target.startsWith(coreDir + '/')) continue;
    const o = imp.name === 'default' || imp.name === '*' ? { file: target, name: imp.name } : resolveOrigin(target, imp.name, read);
    uses.push({ name: o.name, originFile: o.file, specifier: imp.specifier, file: fileName });
  }
  return uses;
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(p));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

// The real tree is read-only for the life of a test run, so each file is parsed (Babel is slow
// under coverage instrumentation) at most once and shared by every test via this index.
const fileUsesCache = new Map<string, CoreUse[]>();
function coreUsesInFile(f: string): CoreUse[] {
  let uses = fileUsesCache.get(f);
  if (!uses) {
    uses = coreUsesInSource(readFileSync(f, 'utf-8'), f, realRead);
    fileUsesCache.set(f, uses);
  }
  return uses;
}

function collectCoreUses(dir: string, skipFiles = new Set<string>()): CoreUse[] {
  return listSourceFiles(dir)
    .filter((f) => !skipFiles.has(relative(ROOT, f)))
    .flatMap(coreUsesInFile);
}

/** True when `name` is referenced as an identifier anywhere outside import declarations. */
function referencesIdentifier(file: string, name: string): boolean {
  let found = false;
  walk(parseSource(readFileSync(file, 'utf-8'), file).body, (n) => {
    if (n.type === 'ImportDeclaration') return false;
    if (n.type === 'Identifier' && n.name === name) found = true;
  });
  return found;
}

function hasStringLiteral(file: string, value: string): boolean {
  let found = false;
  walk(parseSource(readFileSync(file, 'utf-8'), file).body, (n) => {
    if (n.type === 'StringLiteral' && n.value === value) found = true;
  });
  return found;
}

/** `const NAME = <number>` value (undefined if no such declaration) and whether `.slice(0, NAME)` is called anywhere. */
function constCap(src: string, fileName: string, name: string): { value: number | undefined; usedInSlice: boolean } {
  let value: number | undefined;
  let usedInSlice = false;
  walk(parseSource(src, fileName).body, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === name && n.init?.type === 'NumericLiteral') value = n.init.value;
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'slice'
      && n.arguments[0]?.type === 'NumericLiteral' && n.arguments[0].value === 0
      && n.arguments[1]?.type === 'Identifier' && n.arguments[1].name === name) usedInSlice = true;
  });
  return { value, usedInSlice };
}

/** Literal caps in `<expr>.<prop>.slice(0, <number>)` calls. */
function literalSliceCaps(src: string, fileName: string, prop: string): number[] {
  const caps: number[] = [];
  walk(parseSource(src, fileName).body, (n) => {
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'slice'
      && n.callee.object.type === 'MemberExpression' && n.callee.object.property.name === prop
      && n.arguments[0]?.type === 'NumericLiteral' && n.arguments[0].value === 0 && n.arguments[1]?.type === 'NumericLiteral') caps.push(n.arguments[1].value);
  });
  return caps;
}

/** Dynamic `import()`, `require()` and `import x = require()` whose target is core/ (or cannot be resolved statically). */
function dynamicCoreLoads(src: string, fileName: string, read: ReadSource, coreDir = CORE): string[] {
  const hits: string[] = [];
  const check = (arg: N | undefined, how: string) => {
    const lit = arg && (arg.type === 'StringLiteral' ? arg.value : arg.type === 'TemplateLiteral' && arg.expressions.length === 0 ? arg.quasis[0].value.cooked : undefined);
    if (lit === undefined) { hits.push(`${how}(<non-literal>)`); return; }
    const target = resolveSpecifier(lit, fileName, read);
    if (target && target.startsWith(coreDir + '/')) hits.push(`${how}('${lit}')`);
  };
  walk(parseSource(src, fileName).body, (n) => {
    if (n.type === 'ImportExpression') check(n.source, 'import');
    else if (n.type === 'CallExpression' && n.callee.type === 'Import') check(n.arguments[0], 'import');
    else if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require') check(n.arguments[0], 'require');
    else if (n.type === 'TSImportEqualsDeclaration' && n.moduleReference?.type === 'TSExternalModuleReference') check(n.moduleReference.expression, 'import = require');
  });
  return hits;
}

// ── scope ────────────────────────────────────────────────────────────────────

// Pure modules the renderer imports directly — no bridging needed.
const PURE_MODULES = new Set(['fmt', 'dateUtils', 'filters', 'canvas-spec', 'account-class']);

// TUI files that are out of GUI scope.
const SKIP_FILES = new Set(['tui/Setup.tsx', 'tui/index.tsx']);

const modOf = (file: string) => relative(CORE, file).replace(/\.ts$/, '');

const isPure = (u: CoreUse) =>
  PURE_MODULES.has(modOf(u.originFile)) || PURE_MODULES.has(modOf(resolveSpecifier(u.specifier, u.file, realRead)!));

/** Every value import the in-scope TUI screens take from core (origin-attributed, nothing filtered). */
const collectAllTuiUses = () => collectCoreUses(join(ROOT, 'tui'), SKIP_FILES);

function collectTuiCoreImports(): Map<string, string[]> {
  const found = new Map<string, string[]>(); // name → files using it
  for (const u of collectAllTuiUses()) {
    if (isPure(u)) continue;
    if (/^[A-Z0-9_]+$/.test(u.name)) continue; // constants — renderer mirrors or ignores
    found.set(u.name, [...(found.get(u.name) ?? []), relative(ROOT, u.file)]);
  }
  return found;
}

// ── EXPECTED_UNBRIDGED: every reason is a checked claim ─────────────────────

/**
 * renderer-direct   the renderer really imports `name` from core (module = core file that defines it)
 * main-direct       each of `files` (gui/main, outside registry.ts) really imports AND references `name` from core; optional `channel` string must exist too
 * bridged-composed  the GUI exposes the capability under other registry name(s) (via: 'ns.fn', each must exist)
 * ipc-channel       a dedicated IPC channel handles it (file must contain the string literal or identifier `needle`)
 * gui-unused       no gui/** file imports `name`; the GUI replaces it with a channel (file must contain the string literal / identifier `needle`)
 * unused-in-tui     TUI imports the name but never references it
 */
type Claim =
  | { kind: 'renderer-direct'; module: string; why: string }
  | { kind: 'main-direct'; module: string; files: string[]; channel?: { file: string; needle: string }; why: string }
  | { kind: 'bridged-composed'; via: string[]; why: string }
  | { kind: 'ipc-channel'; file: string; needle: string; why: string }
  | { kind: 'gui-unused'; file: string; needle: string; why: string }
  | { kind: 'unused-in-tui'; tuiFile: string; why: string };

const CLAIM_KINDS = ['renderer-direct', 'main-direct', 'bridged-composed', 'ipc-channel', 'gui-unused', 'unused-in-tui'] as const;

const rd = (module: string, why: string): Claim => ({ kind: 'renderer-direct', module, why });

// name → why it's not in the registry (yet). Shrinks as GUI phases land.
const EXPECTED_UNBRIDGED: Record<string, Claim> = {
  // Handled differently in the GUI
  parseCSV: { kind: 'main-direct', module: 'csv', files: ['gui/main/bridge.ts'], why: 'gui/main/bridge.ts parses the picked file itself (files.pickCsv: native dialog + parse in main)' },
  parseDate: rd('csv-date', 'pure core/csv-date.ts'),
  summarizeCsvSkips: rd('csv-import-copy', 'pure core/csv-import-copy.ts'),
  householdMembers: { kind: 'bridged-composed', via: ['profile.getHouseholdMembers'], why: 'exposed as profile.getHouseholdMembers' },
  onRefresh: { kind: 'ipc-channel', file: 'gui/main/refresh-ipc.ts', needle: 'onRefresh', why: 'main process subscribes and pushes refresh events over IPC' },
  notifyChange: { kind: 'main-direct', module: 'refresh', files: ['gui/main/app.ts', 'gui/main/plaid-link.ts'], why: 'gui/main (app.ts, plaid-link.ts) calls it after sync/link; the renderer gets the bump over the refresh channel' },
  summarizeSkips: rd('balance-import-copy', 'pure copy helper in core/balance-import-copy.ts (browser-safe)'),

  // Agent chat is wired through dedicated IPC channels (gui/main/agent-ipc.ts)
  runAgentTurn: { kind: 'ipc-channel', file: 'gui/main/agent-ipc.ts', needle: "'agent:run'", why: 'agent:run channel' },
  detectProvider: { kind: 'ipc-channel', file: 'gui/main/agent-ipc.ts', needle: "'agent:provider'", why: 'agent:provider channel' },
  getProviderModel: { kind: 'ipc-channel', file: 'gui/main/agent-ipc.ts', needle: "'agent:provider'", why: 'agent:provider channel' },


  // Pure scorecard helpers
  bucketDrift: rd('scorecard', 'pure core/scorecard.ts'),
  ratioLabel: rd('scorecard', 'pure core/scorecard.ts'),
  driftSeverity: rd('scorecard', 'pure core/scorecard.ts'),

  mergeRules: rd('rules-merge', 'pure core/rules-merge.ts'),

  // TUI imports it via core/health.ts (re-export); defined in savings-rate.ts so the
  // browser bundle doesn't pull in db.ts/crypto.ts
  computeSavingsRate: rd('savings-rate', 'pure core/savings-rate.ts'),

  // Electron-side bridge namespaces live in gui/main/bridge.ts (not registry.ts)
  getDefaultDaysRequested: { kind: 'main-direct', module: 'settings', files: ['gui/main/bridge.ts'], why: 'bridge plaid namespace (gui/main/bridge.ts)' },

  // Session-only sync-failure store (core/sync-status.ts): main pushes it to the renderer
  // over the sync-status channel (gui/main/sync-status-ipc.ts) instead of the bridge.
  setSyncResult: { kind: 'main-direct', module: 'sync-status', files: ['gui/main/app.ts'], channel: { file: 'gui/main/sync-status-ipc.ts', needle: 'sync-status' }, why: 'gui/main/app.ts records the startup-sync result; pushed to the renderer by sync-status-ipc.ts' },
  mergeSyncResult: { kind: 'main-direct', module: 'sync-status', files: ['gui/main/sync-ipc.ts'], why: 'used by gui/main/sync-ipc.ts' },
  getSyncFailures: { kind: 'main-direct', module: 'sync-status', files: ['gui/main/sync-status-ipc.ts'], why: 'used by gui/main/sync-status-ipc.ts' },
  onSyncStatus: { kind: 'main-direct', module: 'sync-status', files: ['gui/main/sync-status-ipc.ts'], why: 'used by gui/main/sync-status-ipc.ts' },
  // Pure formatter for syncAll's onProgress steps; the callback can't cross IPC
  describeSyncProgress: { kind: 'gui-unused', file: 'gui/main/sync-progress-ipc.ts', needle: 'sync-progress', why: 'progress callback cannot cross IPC; the GUI pushes an in-progress flag over the sync-progress channel instead' },

  // Plaid error text
  plaidErrorMessage: { kind: 'main-direct', module: 'plaid', files: ['gui/main/app.ts'], why: 'gui/main/app.ts formats startup-sync errors with it; syncAll results already carry formatted errors' },

  // Composed actions
  deleteSyncCursor: { kind: 'bridged-composed', via: ['sync.deleteCursorAndResync'], why: 'GUI bridges the composed sync.deleteCursorAndResync instead' },
  updateHistoryEntrySpec: { kind: 'bridged-composed', via: ['canvas.updateSpec'], why: 'GUI bridges the composed canvas.updateSpec instead' },
  resolveAndWriteCanvasSpec: { kind: 'bridged-composed', via: ['canvas.updateSpec'], why: 'GUI bridges the composed canvas.updateSpec instead' },

  // On-demand /transactions/refresh: dedicated streaming channel
  refreshTransactions: { kind: 'ipc-channel', file: 'gui/main/sync-ipc.ts', needle: "'sync:refresh'", why: 'streaming sync-ipc channel, not the registry' },
  describeRefreshProgress: rd('transactions-refresh-format', 'formats pushed progress steps'),
  describeRefreshResult: rd('transactions-refresh-format', 'formats the final result'),

  // Generic settings access — GUI uses typed wrappers
  getSetting: { kind: 'bridged-composed', via: ['settings.getPretaxMonthly'], why: 'typed wrappers (getPretaxMonthly/setPretaxMonthly) instead of generic access' },
  setSetting: { kind: 'bridged-composed', via: ['settings.setPretaxMonthly'], why: 'typed wrappers (getPretaxMonthly/setPretaxMonthly) instead of generic access' },

  resolveCsvAmount: rd('csv-amount', 'pure core/csv-amount.ts (re-exported by accounts.ts)'),

  // Pure FIRE/runway/debt-payoff helpers
  computeFireRunwayMetrics: rd('health-metrics', 'pure helper'),
  savingsRateSeverity: rd('health-metrics', 'pure helper'),
  runwaySeverity: rd('health-metrics', 'pure helper'),
  debtPayoffSeverity: rd('health-metrics', 'pure helper'),

  // Pure account-grouping helpers
  groupAccountsByType: rd('account-rollup', 'pure account grouping'),
  buildTypeToAccountIds: rd('account-rollup', 'pure account grouping'),
};

// Pure-module functions (module:name) the TUI uses that the renderer does not. Empty is the goal.
const PURE_TUI_ONLY: Record<string, string> = {};

// Known dynamic core loads that are harmless to the parity scan.
const DYNAMIC_CORE_ALLOWED: Record<string, string> = {
  "gui/main/index.ts: import('../../core/paths.js')": 'loads only the DATA_DIR constant after FUNGIBLE_DATA_DIR is set; not a feature function',
};

// ── tests ────────────────────────────────────────────────────────────────────

describe('import parser (fixtures)', () => {
  // Virtual repo: /v/core/{a,b,barrel,star}.ts, consumers in /v/tui
  const files: Record<string, string> = {
    '/v/core/a.ts': 'export function alpha() {}\nexport const BETA = 1;\nexport { gamma as gammaAlias } from "./b.js";',
    '/v/core/b.ts': 'export function gamma() {}\nexport function delta() {}\nexport default function main() {}',
    '/v/core/barrel.ts': 'export { alpha as alphaRenamed } from "./a.js";\nexport * from "./b.js";\nexport type { T } from "./a.js";',
    '/v/core/star.ts': 'export * from "./barrel.js";',
    '/v/core/local.ts': 'import { delta as d2, type T } from "./b.js";\nexport { d2 as deltaLocal };',
  };
  const read: ReadSource = (p) => files[p];
  const uses = (src: string) => coreUsesInSource(src, '/v/tui/X.tsx', read, '/v/core').map((u) => `${modOf2(u.originFile)}:${u.name}`).sort();
  const modOf2 = (f: string) => relative('/v/core', f).replace(/\.ts$/, '');

  it('detects named, aliased and multi-line imports under their original names', () => {
    expect(uses(`import { alpha as a1,\n  BETA,\n} from '../core/a.js';\nimport { delta as d } from '../core/b.js';`))
        .toEqual(['a:BETA', 'a:alpha', 'b:delta']);
  });
  it('detects default imports', () => {
    expect(uses(`import main from '../core/b.js';`)).toEqual(['b:default']);
    expect(uses(`import main, { delta } from '../core/b.js';`)).toEqual(['b:default', 'b:delta']);
  });
  it('detects namespace imports by property access, and "*" when used as a value', () => {
    expect(uses(`import * as c from '../core/b.js';\nc.gamma(); const x = c.delta;`)).toEqual(['b:delta', 'b:gamma']);
    expect(uses(`import * as c from '../core/b.js';\nuse(c);`)).toEqual(['b:*']);
  });
  it('ignores type-only imports and inline type specifiers', () => {
    expect(uses(`import type { alpha } from '../core/a.js';\nimport type D from '../core/b.js';`)).toEqual([]);
    expect(uses(`import { type alpha, delta } from '../core/b.js';`)).toEqual(['b:delta']);
  });
  it('ignores non-core and bare imports', () => {
    expect(uses(`import { spawn } from 'node:child_process';\nimport './x.js';\nimport { y } from './local.js';`)).toEqual([]);
  });
  it('attributes names imported through a barrel to the defining module (alias, star, nested star)', () => {
    expect(uses(`import { alphaRenamed } from '../core/barrel.js';`)).toEqual(['a:alpha']);
    expect(uses(`import { delta } from '../core/barrel.js';`)).toEqual(['b:delta']);
    expect(uses(`import { delta, alphaRenamed } from '../core/star.js';`)).toEqual(['a:alpha', 'b:delta']);
    expect(uses(`import { gammaAlias } from '../core/a.js';`)).toEqual(['b:gamma']);
    expect(uses(`import { deltaLocal } from '../core/local.js';`)).toEqual(['b:delta']); // import-then-export
  });
  it('counts `export ... from` in a consumer as use, but not `export type`', () => {
    expect(uses(`export { delta } from '../core/b.js';\nexport type { T } from '../core/a.js';`)).toEqual(['b:delta']);
  });
});

describe('dynamic core loads (fixtures)', () => {
  const read: ReadSource = (p) => (p === '/v/core/a.ts' ? 'export function alpha() {}' : undefined);
  const hits = (src: string) => dynamicCoreLoads(src, '/v/tui/X.tsx', read, '/v/core');
  it('flags import(), require() and import = require() that resolve to core', () => {
    expect(hits(`const m = await import('../core/a.js');`)).toEqual([`import('../core/a.js')`]);
    expect(hits('const m = require(`../core/a.js`);')).toEqual([`require('../core/a.js')`]);
    expect(hits(`import a = require('../core/a.js');`)).toEqual([`import = require('../core/a.js')`]);
  });
  it('flags non-literal specifiers, ignores non-core targets', () => {
    expect(hits(`import(x);`)).toEqual(['import(<non-literal>)']);
    expect(hits(`import('node:fs'); require('./local.js'); import('../core/missing.js');`)).toEqual([]);
  });
});

describe('GUI bridge feature parity with TUI', { timeout: 30_000 }, () => {
  let registryNames: Set<string>;
  let registryPaths: Set<string>;
  let rendererUses: CoreUse[];
  let mainUses: CoreUse[];
  let registryUses: CoreUse[];

  beforeAll(async () => {
    process.env.FUNGIBLE_DATA_DIR = mkdtempSync(join(tmpdir(), 'fungible-parity-'));
    const { registry } = await import('../gui/main/registry.js');
    registryNames = new Set(
      Object.values(registry).flatMap((ns) => Object.keys(ns as Record<string, unknown>)),
    );
    registryPaths = new Set(
      Object.entries(registry).flatMap(([ns, fns]) => Object.keys(fns as Record<string, unknown>).map((f) => `${ns}.${f}`)),
    );
    rendererUses = collectCoreUses(join(ROOT, 'gui/renderer/src'));
    mainUses = collectCoreUses(join(ROOT, 'gui/main'), new Set(['gui/main/registry.ts']));
    registryUses = coreUsesInFile(join(ROOT, 'gui/main/registry.ts'));
    // Build the whole import index once, here, so per-test bodies only filter cached results.
    collectCoreUses(join(ROOT, 'tui'));
  }, 120_000);

  it('every core function used by a TUI screen is bridged or accounted for', () => {
    const tuiImports = collectTuiCoreImports();
    expect(tuiImports.size).toBeGreaterThan(30); // the parse is finding real imports
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
    const bridged = Object.keys(EXPECTED_UNBRIDGED).filter((name) => registryNames.has(name));
    expect(
      bridged,
      `These are now bridged — remove them from EXPECTED_UNBRIDGED:\n  ${bridged.join('\n  ')}`,
    ).toEqual([]);
    const allTui = new Set(collectAllTuiUses().map((u) => u.name));
    const unused = Object.keys(EXPECTED_UNBRIDGED).filter((name) => !allTui.has(name));
    expect(
      unused,
      `The TUI no longer imports these (value imports from core, non-skipped screens) — remove them from EXPECTED_UNBRIDGED:\n  ${unused.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every claim has an allowed kind and a non-empty reason', () => {
    for (const [name, c] of Object.entries(EXPECTED_UNBRIDGED)) {
      expect(CLAIM_KINDS as readonly string[], `${name}: unknown claim kind "${c.kind}"`).toContain(c.kind);
      expect(c.why.trim().length, `${name}: empty reason`).toBeGreaterThan(0);
    }
  });

  it('claims are true: each reason is verified against the code it points at', () => {
    const problems: string[] = [];
    const hasUse = (uses: CoreUse[], name: string, module: string) =>
      uses.some((u) => u.name === name && (modOf(u.originFile) === module || u.specifier.endsWith(`/${module}.js`)));
    for (const [name, c] of Object.entries(EXPECTED_UNBRIDGED)) {
      switch (c.kind) {
        case 'renderer-direct':
          if (!hasUse(rendererUses, name, c.module)) problems.push(`${name}: claims the renderer imports it from core/${c.module}.ts, but no gui/renderer/src file does`);
          break;
        case 'main-direct': {
          for (const f of c.files) {
            const abs = join(ROOT, f);
            const imported = mainUses.some((u) => u.file === abs && u.name === name && (modOf(u.originFile) === c.module || u.specifier.endsWith(`/${c.module}.js`)));
            if (!imported) problems.push(`${name}: claims ${f} imports it from core/${c.module}.ts, but it does not`);
            else if (!referencesIdentifier(abs, name)) problems.push(`${name}: ${f} imports it from core/${c.module}.ts but never references it`);
          }
          if (c.channel && !hasStringLiteral(join(ROOT, c.channel.file), c.channel.needle)) problems.push(`${name}: ${c.channel.file} no longer has the string literal '${c.channel.needle}'`);
          break;
        }
        case 'bridged-composed':
          for (const v of c.via) if (!registryPaths.has(v)) problems.push(`${name}: claims it is bridged as ${v}, but the registry has no such entry`);
          break;
        case 'ipc-channel':
        case 'gui-unused': {
          if (c.kind === 'gui-unused') {
            const importers = [...rendererUses, ...mainUses, ...registryUses].filter((u) => u.name === name);
            if (importers.length) problems.push(`${name}: claimed unused by the GUI, but ${[...new Set(importers.map((u) => relative(ROOT, u.file)))].join(', ')} imports it`);
          }
          const path = join(ROOT, c.file);
          if (realRead(path) === undefined) problems.push(`${name}: ${c.file} does not exist`);
          else if (!hasStringLiteral(path, c.needle.replace(/^'|'$/g, '')) && !referencesIdentifier(path, c.needle)) problems.push(`${name}: ${c.file} no longer has the string literal or identifier ${c.needle}`);
          break;
        }
        case 'unused-in-tui': {
          const path = join(ROOT, c.tuiFile);
          const text = readFileSync(path, 'utf-8');
          let refs = 0;
          walk(parseSource(text, path).body, (n) => {
            if (n.type === 'ImportDeclaration') return false;
            if (n.type === 'Identifier' && n.name === name) refs++;
          });
          const imported = parseImports(text, path).some((i) => i.name === name);
          if (!imported) problems.push(`${name}: ${c.tuiFile} does not import it`);
          else if (refs > 0) problems.push(`${name}: ${c.tuiFile} now uses it (${refs} references), so it is not "unused"`);
          break;
        }
      }
    }
    expect(problems, `Unverified EXPECTED_UNBRIDGED claims:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  // The header promise: pure modules need no bridge because the renderer imports them itself.
  it('every pure-module function the TUI uses is also imported by the renderer', () => {
    const rendererNames = new Set(rendererUses.map((u) => `${modOf(u.originFile)}:${u.name}`));
    const missing = [...new Set(collectAllTuiUses().filter(isPure).filter((u) => !/^[A-Z0-9_]+$/.test(u.name))
      .map((u) => `${modOf(u.originFile)}:${u.name}`))]
      .filter((k) => !rendererNames.has(k) && !(k in PURE_TUI_ONLY));
    expect(missing, `TUI uses these pure core functions but the renderer never imports them. Port the behaviour to the GUI or record it in PURE_TUI_ONLY with a reason:\n  ${missing.join('\n  ')}`).toEqual([]);
    const stale = Object.keys(PURE_TUI_ONLY).filter((k) => rendererNames.has(k));
    expect(stale, `The renderer now imports these -- remove from PURE_TUI_ONLY:\n  ${stale.join('\n  ')}`).toEqual([]);
  });

  // Shared copy: both surfaces must take user-facing import/skip text from the same core module.
  it('TUI and GUI take CSV / balance-import skip copy from the same core exports', () => {
    const tuiUses = collectCoreUses(join(ROOT, 'tui'));
    for (const [name, module] of [
      ['summarizeCsvSkips', 'csv-import-copy'],
      ['CSV_SKIP_COPY', 'csv-import-copy'],
      ['summarizeSkips', 'balance-import-copy'],
      ['BALANCE_IMPORT_SKIP_COPY', 'balance-import-copy'],
    ] as const) {
      expect(tuiUses.some((u) => u.name === name && modOf(u.originFile) === module), `TUI no longer imports ${name} from core/${module}`).toBe(true);
      expect(rendererUses.some((u) => u.name === name && modOf(u.originFile) === module), `GUI renderer no longer imports ${name} from core/${module}`).toBe(true);
    }
  });

  it('no dynamic import()/require() of core hides from the static import scan', () => {
    const files = [join(ROOT, 'tui'), join(ROOT, 'gui/renderer/src'), join(ROOT, 'gui/main')]
      .flatMap(listSourceFiles).filter((f) => relative(ROOT, f) !== 'gui/main/registry.ts');
    const hits = files.flatMap((f) => dynamicCoreLoads(readFileSync(f, 'utf-8'), f, realRead).map((h) => `${relative(ROOT, f)}: ${h}`));
    const unexpected = hits.filter((h) => !(h in DYNAMIC_CORE_ALLOWED));
    const staleAllow = Object.keys(DYNAMIC_CORE_ALLOWED).filter((h) => !hits.includes(h));
    expect(staleAllow, `Remove from DYNAMIC_CORE_ALLOWED:\n  ${staleAllow.join('\n  ')}`).toEqual([]);
    expect(unexpected, `These files load core dynamically, which this test cannot attribute. Use a static import:\n  ${unexpected.join('\n  ')}`).toEqual([]);
  });

  // KNOWN DRIFT (pinned, not endorsed): list caps differ between surfaces. Reconciling them is a
  // product call; when you do, update these numbers on purpose.
  it('KNOWN DRIFT: balance-import skipped-row preview cap is TUI 5 vs GUI 20', () => {
    const tuiPath = join(ROOT, 'tui/Accounts.tsx');
    const guiPath = join(ROOT, 'gui/renderer/src/components/BalanceHistoryImportModal.tsx');
    const tui = constCap(readFileSync(tuiPath, 'utf-8'), tuiPath, 'CAP');
    const gui = constCap(readFileSync(guiPath, 'utf-8'), guiPath, 'SKIPPED_LIST_CAP');
    expect(tui.value, 'TUI CAP constant not found in tui/Accounts.tsx').toBeDefined();
    expect(gui.value, 'SKIPPED_LIST_CAP constant not found in BalanceHistoryImportModal.tsx').toBeDefined();
    expect(tui.usedInSlice, 'TUI CAP is no longer used in .slice(0, CAP)').toBe(true);
    expect(gui.usedInSlice, 'GUI SKIPPED_LIST_CAP is no longer used in .slice(0, SKIPPED_LIST_CAP)').toBe(true);
    expect({ tui: tui.value, gui: gui.value }).toEqual({ tui: 5, gui: 20 });
  });

  it('KNOWN DRIFT: CSV-import done-message skipped-line cap is TUI 5 vs GUI 3', () => {
    const tuiPath = join(ROOT, 'tui/Accounts.tsx');
    const guiPath = join(ROOT, 'gui/renderer/src/screens/Accounts.tsx');
    const tuiCaps = literalSliceCaps(readFileSync(tuiPath, 'utf-8'), tuiPath, 'skippedRows');
    const gui = constCap(readFileSync(guiPath, 'utf-8'), guiPath, 'SKIPPED_LINES_SHOWN');
    expect(tuiCaps.length, 'no <x>.skippedRows.slice(0, N) found in tui/Accounts.tsx').toBeGreaterThan(0);
    expect(gui.value, 'SKIPPED_LINES_SHOWN constant not found in gui Accounts.tsx').toBeDefined();
    expect(gui.usedInSlice, 'GUI SKIPPED_LINES_SHOWN is no longer used in .slice(0, SKIPPED_LINES_SHOWN)').toBe(true);
    expect({ tui: tuiCaps, gui: gui.value }).toEqual({ tui: [5], gui: 3 });
  });
});
