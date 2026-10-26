import { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  getSplitConfig, getSettleMonths, setupSplit, settleMonth, unsettleMonth, countTransactionsTagged,
  type SplitConfig,
} from '../core/split.js';
import type { SettleMonth, RatioSlice } from '../core/split-math.js';
import { MONTHS } from '../core/dateUtils.js';
import type { Screen, TxFilter } from './App.js';
import { fmt, truncate, Divider } from './fmt.js';
import { handleNavKey } from './nav.js';
import { useTerminalWidth, C_POSITIVE, C_NEGATIVE, C_WARNING, C_ACCENT } from './ui.js';
import { PageHeader, ModalPanel, SelectableRow, SectionHeader, EditTextField, useStatusMessage, usePagination } from './components/index.js';
import { useSetTyping } from './TypingContext.js';
import { useRefreshKey } from './RefreshContext.js';
import { useFilter } from './FilterContext.js';
import { useLoadError, LoadError } from './useLoadError.js';
import { useLoadGuard } from './useLoadGuard.js';

// Settle up (#310): split joint-tagged expenses by a ratio and settle each
// calendar month. Opened with [s] from the Dashboard's Owner view; runs setup
// first when the split isn't configured yet.

type Mode = 'list' | 'setup' | 'confirm-settle' | 'confirm-unsettle';
type Ready = Extract<SplitConfig, { status: 'ready' }>;

const SETUP_FIELDS = ['joint', 'settled', 'pct', 'start'] as const;
type SetupField = typeof SETUP_FIELDS[number];
const SETUP_LABELS: Record<SetupField, string> = {
  joint: 'Joint tag', settled: 'Settled tag', pct: 'Your share %', start: 'Starts',
};
// Characters each setup field accepts as you type.
const SETUP_CHARS: Partial<Record<SetupField, RegExp>> = { pct: /^[0-9.]$/, start: /^[0-9-]$/ };

function firstOfThisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

const monthLabel = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const monthDate = (month: string) => new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
const longMonth = (month: string) => monthDate(month).toLocaleString('en-US', { month: 'long', year: 'numeric' });
const monthName = (month: string) => monthDate(month).toLocaleString('en-US', { month: 'long' });
const dayLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const pct = (n: number) => `${+n.toFixed(2)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Alex pays Pat $12.40" for net > 0 (spouse owed self), the reverse for net < 0. */
function direction(net: number, c: Ready, verb: 'pays' | 'paid', decimals = 2): string {
  if (net === 0) return 'even';
  return net > 0
    ? `${c.spouse} ${verb} ${c.self} ${fmt(net, decimals)}`
    : `${c.self} ${verb} ${c.spouse} ${fmt(-net, decimals)}`;
}

/** Compact "Pat → Alex $700" for the month list. */
function arrow(net: number, c: Ready, w: number): string {
  if (net === 0) return 'even';
  const [from, to] = net > 0 ? [c.spouse, c.self] : [c.self, c.spouse];
  return `${truncate(from, w)} → ${truncate(to, w)} ${fmt(Math.abs(net), 0)}`;
}

/** Which days of the month a slice covers, when that isn't the whole month. */
function sliceSpan(s: RatioSlice, i: number, n: number, m: SettleMonth): string {
  if (n === 1) return s.from > m.from ? ` from ${dayLabel(s.from)}` : '';
  if (i === 0) return s.from > m.from ? ` ${dayLabel(s.from)}–${dayLabel(s.to)}` : ` through ${dayLabel(s.to)}`;
  if (i === n - 1) return ` from ${dayLabel(s.from)}`;
  return ` ${dayLabel(s.from)}–${dayLabel(s.to)}`;
}

const STATUS_LABEL: Record<SettleMonth['status'], string> = { empty: '—', open: 'open', settled: 'settled', 'top-up': 'top-up' };
const MONTH_PAGE = 12;

export function Settle({ onNavigate, isActive, initialFilter, showHints }: { onNavigate: (s: Screen, f?: TxFilter) => void; isActive?: boolean; initialFilter?: TxFilter; showHints: boolean }) {
  const { loadError, track } = useLoadError();
  const refreshKey = useRefreshKey();
  const { setFilter } = useFilter();
  const guard = useLoadGuard();
  const { statusMsg, showStatus } = useStatusMessage(3000);
  const [config, setConfig] = useState<SplitConfig | null>(null);
  const [months, setMonths] = useState<SettleMonth[]>([]);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>('list');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [setup, setSetup] = useState<Record<SetupField, string>>({ joint: 'joint', settled: 'settled', pct: '', start: firstOfThisMonth() });
  const [setupField, setSetupField] = useState(0);
  // Set once the settled tag name was found already on transactions; a second Enter proceeds.
  const [setupWarned, setSetupWarned] = useState<string | null>(null);

  const initialCursorDone = useRef(false);
  function load() {
    const token = guard.begin();
    void track(Promise.all([getSplitConfig(), getSettleMonths()])).then(([c, ms]) => {
      if (!guard.isLatest(token)) return;
      setConfig(c);
      setMonths(ms);
      if (c.status === 'unconfigured') setMode((m) => (m === 'list' ? 'setup' : m));
      if (!initialCursorDone.current && ms.length > 0) {
        initialCursorDone.current = true;
        const want = initialFilter?.anchor?.slice(0, 7);
        const idx = want ? ms.findIndex((m) => m.month === want) : -1;
        setCursor(idx >= 0 ? idx : 0);
      } else {
        setCursor((i) => Math.min(i, Math.max(0, ms.length - 1)));
      }
    });
  }
  useEffect(load, [refreshKey]);

  const setTyping = useSetTyping();
  useEffect(() => {
    setTyping(mode === 'setup');
    return () => setTyping(false);
  }, [mode]);

  const ready = config?.status === 'ready' ? config : null;
  const month = months[cursor];

  function back() {
    onNavigate('dashboard', { dashView: 'owner', range: 'month', ...(month ? { anchor: month.from } : {}) });
  }

  async function submitSetup() {
    setError(null);
    const settledName = setup.settled.trim();
    if (setupWarned !== settledName && settledName) {
      const n = await countTransactionsTagged(settledName);
      if (n > 0) {
        setSetupWarned(settledName);
        setError(`${plural(n, 'transaction')} already ${n === 1 ? 'carries' : 'carry'} "${settledName}" and will count as settled. Enter again to continue.`);
        return;
      }
    }
    setBusy(true);
    try {
      await setupSplit({
        jointTagName: setup.joint,
        settledTagName: setup.settled,
        selfPct: setup.pct.trim() === '' ? Number.NaN : Number(setup.pct),
        startDate: setup.start.trim(),
      });
      setMode('list');
      showStatus('Expense split is set up');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runWrite(write: () => Promise<void>, done: string, failed: string) {
    setBusy(true);
    try {
      await write();
      showStatus(done);
      load();
    } catch (err) {
      setError(`${failed}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setMode('list');
      setBusy(false);
    }
  }

  useInput((input, key) => {
    if (busy) return;

    if (mode === 'setup') {
      const field = SETUP_FIELDS[setupField];
      if (key.escape) { back(); return; }
      if (key.upArrow) { setSetupField((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow || key.tab) { setSetupField((i) => Math.min(SETUP_FIELDS.length - 1, i + 1)); return; }
      if (key.return) { void submitSetup(); return; }
      if (key.backspace || key.delete) { setSetup((s) => ({ ...s, [field]: s[field].slice(0, -1) })); return; }
      if (input && !key.ctrl && !key.meta) {
        const allowed = SETUP_CHARS[field];
        const typed = allowed ? [...input].filter((ch) => allowed.test(ch)).join('') : input;
        if (typed) setSetup((s) => ({ ...s, [field]: s[field] + typed }));
      }
      return;
    }

    if (mode === 'confirm-settle' || mode === 'confirm-unsettle') {
      if (!month || !ready) { setMode('list'); return; }
      if (input === 'y') {
        const label = longMonth(month.month);
        if (mode === 'confirm-settle') {
          void runWrite(() => settleMonth(month.tagIds, month.untagIds), `Settled ${label}`, `Could not settle ${label}`);
        } else {
          void runWrite(() => unsettleMonth(month.month), `Unsettled ${label}`, `Could not unsettle ${label}`);
        }
        return;
      }
      if (input === 'n' || key.escape) { setMode('list'); return; }
      return;
    }

    // list mode
    if (handleNavKey(input, 'settle', onNavigate)) return;
    if (key.escape) { back(); return; }
    if (!ready || !month) return;
    if (key.upArrow) { setCursor((c) => Math.max(0, c - 1)); setError(null); return; }
    if (key.downArrow) { setCursor((c) => Math.min(months.length - 1, c + 1)); setError(null); return; }
    if (key.return) {
      setFilter({ tags: [{ name: ready.jointTag.name, mode: 'has' }] });
      onNavigate('transactions', { from: month.from, to: month.to, range: 'month', anchor: month.from, drillFrom: 'settle' });
      return;
    }
    if (input === 's') {
      setError(null);
      if (month.blockedIds.length > 0) {
        setError(`Can't settle ${longMonth(month.month)}: ${plural(month.blockedIds.length, 'joint transaction')} on an account not owned by ${ready.self} or ${ready.spouse}. Assign owners in [8] accounts.`);
        return;
      }
      if (month.tagIds.length === 0 && month.untagIds.length === 0) { showStatus(`Nothing to settle for ${longMonth(month.month)}`); return; }
      setMode('confirm-settle');
      return;
    }
    if (input === 'u') {
      setError(null);
      if (month.status !== 'settled' && month.status !== 'top-up') { showStatus(`Nothing settled in ${longMonth(month.month)}`); return; }
      setMode('confirm-unsettle');
      return;
    }
  }, { isActive: isActive !== false });

  const termW = useTerminalWidth();
  const inner = Math.max(60, termW) - 4;
  const nameW = 8;
  // [sel=2] [month=8] [joint=9] [self=8] [spouse=8] [to settle] [status=7], gaps of 2
  const settleW = Math.max(18, Math.min(28, inner - 55));
  // A split that started years ago has more months than fit beside the detail pane.
  const { visible: visibleMonths, pageStart } = usePagination(months, cursor, MONTH_PAGE);

  if (loadError) return <LoadError message={loadError} />;

  const latest = ready?.ratios[ready.ratios.length - 1];
  const ratioText = ready && latest ? `  ·  ${ready.self} ${pct(latest.selfPct)} / ${ready.spouse} ${pct(100 - latest.selfPct)} from ${latest.startDate}` : '';
  // Left to settle over every month, summed from each month's rounded amount so it
  // matches settling them one at a time.
  const anyOpen = months.some((m) => m.status === 'open' || m.status === 'top-up');
  const allToSettle = months.reduce((cents, m) => cents + Math.round(m.toSettle * 100), 0) / 100;
  const totalText = ready && months.some((m) => m.status !== 'empty')
    ? `All months: ${anyOpen ? direction(allToSettle, ready, 'pays') : 'settled'}` : '';
  // The total follows the ratio, or takes its own line when both don't fit.
  const totalInline = `Settle up${ratioText}  ·  ${totalText}`.length <= inner;
  const header = (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Settle up
        {ratioText && <Text dimColor>{ratioText}</Text>}
        {totalText && totalInline && <Text>{`  ·  ${totalText}`}</Text>}
      </Text>
      {totalText && !totalInline && <Text bold>{totalText}</Text>}
      {mode === 'list' && ready && (
        <Text dimColor>{showHints ? '↑↓ month  ·  Enter joint txns  ·  [s] settle  ·  [u] unsettle  ·  Esc back' : '[s] settle  ·  [u] unsettle'}</Text>
      )}
    </Box>
  );

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <PageHeader current="settle" showHints={showHints} />
      {header}
      <Box marginTop={1}><Divider /></Box>

      {config === null ? (
        <Box marginTop={1}><Text dimColor>Loading…</Text></Box>
      ) : config.status === 'needs-household' ? (
        <Box marginTop={1} flexDirection="column">
          <Text>Splitting expenses needs your name and your spouse's name.</Text>
          <Text dimColor>Add them in Settings [0], then come back with [s] on the Dashboard's Owner view.</Text>
        </Box>
      ) : mode === 'setup' ? (
        <ModalPanel title="Set up expense splitting">
          <Text dimColor>Joint-tagged expenses are split by your share; settling a month adds the settled tag to its joint transactions.</Text>
          <Box flexDirection="column" marginTop={1}>
            {SETUP_FIELDS.map((f, i) => (
              <EditTextField key={f} label={SETUP_LABELS[f]} labelWidth={13} active={i === setupField} value={setup[f]} color={C_WARNING}
                placeholder={f === 'pct' ? 'e.g. 60' : f === 'start' ? 'YYYY-MM-DD' : undefined} />
            ))}
          </Box>
          <Box marginTop={1}><Text dimColor>↑↓ field  ·  Enter save  ·  Esc cancel</Text></Box>
          {error && <Text color={C_NEGATIVE}>{error}</Text>}
        </ModalPanel>
      ) : ready && (
        <>
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>
              {'  '}{'Month'.padEnd(8)}  {'Joint'.padStart(9)}  {truncate(ready.self, nameW).padStart(nameW)}  {truncate(ready.spouse, nameW).padStart(nameW)}  {'To settle'.padEnd(settleW)}  Status
            </Text>
            {visibleMonths.map((m, j) => {
              const sel = pageStart + j === cursor;
              const settleText = m.tagIds.length + m.untagIds.length === 0 ? '—' : arrow(m.toSettle, ready, nameW);
              const blocked = m.blockedIds.length > 0;
              return (
                <SelectableRow key={m.month} selected={sel}>
                  <Text color={sel ? C_ACCENT : undefined}>{monthLabel(m.month).padEnd(8)}</Text>
                  <Text dimColor={!sel}>{fmt(m.jointTotal, 0).padStart(9)}</Text>
                  <Text dimColor={!sel}>{fmt(m.selfPaid, 0).padStart(nameW)}</Text>
                  <Text dimColor={!sel}>{fmt(m.spousePaid, 0).padStart(nameW)}</Text>
                  <Text dimColor={!sel}>{truncate(settleText, settleW).padEnd(settleW)}</Text>
                  <Text color={blocked ? C_NEGATIVE : m.status === 'settled' ? C_POSITIVE : m.status === 'empty' ? undefined : C_WARNING}
                    dimColor={m.status === 'empty'}>
                    {blocked ? 'blocked' : STATUS_LABEL[m.status]}
                  </Text>
                </SelectableRow>
              );
            })}
            {months.length > MONTH_PAGE && (
              <Text dimColor>{`  ${pageStart + 1}–${pageStart + visibleMonths.length} of ${months.length} months`}</Text>
            )}
          </Box>

          <Box marginTop={1}><Divider /></Box>

          {month && <MonthDetail m={month} c={ready} />}

          {error && <Box marginTop={1}><Text color={C_NEGATIVE}>{error}</Text></Box>}
          {statusMsg && <Text color={C_POSITIVE}>{statusMsg}</Text>}

          {mode === 'confirm-settle' && month && (
            <ModalPanel title={`Settle ${longMonth(month.month)}`} borderColor={C_WARNING}>
              <Text bold>{month.toSettle === 0 ? 'Nothing changes hands' : direction(month.toSettle, ready, 'pays')}</Text>
              <Text dimColor>
                {`Tags ${plural(month.tagIds.length, 'transaction')} settled`}
                {month.untagIds.length > 0 ? ` and reverses ${plural(month.untagIds.length, 'settled transaction')} that no longer count` : ''}.
              </Text>
              {month.pendingCount > 0 && <Text color={C_WARNING}>⚠ {plural(month.pendingCount, 'joint transaction')} still pending</Text>}
              {month.inProgress && <Text color={C_WARNING}>⚠ {longMonth(month.month)} isn't over yet</Text>}
              <Box marginTop={1}><Text dimColor>[y] settle  ·  [n] cancel</Text></Box>
            </ModalPanel>
          )}
          {mode === 'confirm-unsettle' && month && (
            <ModalPanel title={`Unsettle ${longMonth(month.month)}`} borderColor={C_WARNING}>
              <Text>Remove the settled tag from every transaction in {longMonth(month.month)}?</Text>
              <Box marginTop={1}><Text dimColor>[y] unsettle  ·  [n] cancel</Text></Box>
            </ModalPanel>
          )}
        </>
      )}
    </Box>
  );
}

function MonthDetail({ m, c }: { m: SettleMonth; c: Ready }) {
  const owesRows = [
    { label: `${c.spouse} owes ${c.self}`, share: (s: RatioSlice) => 100 - s.selfPct, paid: (s: RatioSlice) => s.selfPaid, owes: (s: RatioSlice) => s.spouseOwesSelf },
    { label: `${c.self} owes ${c.spouse}`, share: (s: RatioSlice) => s.selfPct, paid: (s: RatioSlice) => s.spousePaid, owes: (s: RatioSlice) => s.selfOwesSpouse },
  ];
  const settledBefore = m.status === 'settled' || m.status === 'top-up';
  const labelW = Math.max(16, ...owesRows.map((r) => r.label.length));
  const line = (label: string, value: string, key: string) => (
    <Box key={key} gap={2}><Text>{label.padEnd(labelW)}</Text><Text>{value}</Text></Box>
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      <SectionHeader>{monthLabel(m.month).toUpperCase()}</SectionHeader>
      <Box flexDirection="column" marginTop={1}>
        {owesRows.flatMap((r) => m.slices.map((s, i) =>
          line(i === 0 ? r.label : '', `${pct(r.share(s))} of ${fmt(r.paid(s))}${sliceSpan(s, i, m.slices.length, m)}  =  ${fmt(r.owes(s))}`, `${r.label}-${i}`),
        ))}
        {settledBefore && line('Month total', direction(m.monthNet, c, 'pays'), 'total')}
        {settledBefore && line('Already settled', direction(m.alreadySettled, c, 'paid'), 'settled')}
        {line('To settle', m.tagIds.length + m.untagIds.length === 0 ? '—' : direction(m.toSettle, c, 'pays'), 'to-settle')}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {m.blockedIds.length > 0 && (
          <Text color={C_NEGATIVE}>✗ {plural(m.blockedIds.length, 'joint transaction')} on an account not owned by {c.self} or {c.spouse} — settling is blocked</Text>
        )}
        {m.pendingCount > 0 && <Text color={C_WARNING}>⚠ {plural(m.pendingCount, 'joint transaction')} still pending</Text>}
        {m.inProgress && <Text color={C_WARNING}>⚠ {monthName(m.month)} isn't over yet</Text>}
        {m.hiddenCount > 0 && <Text dimColor>· {plural(m.hiddenCount, 'joint-tagged transaction')} left out (hidden category)</Text>}
        {m.untagIds.length > 0 && <Text dimColor>· {plural(m.untagIds.length, 'settled transaction')} no longer {m.untagIds.length === 1 ? 'counts' : 'count'} and will be reversed</Text>}
      </Box>
    </Box>
  );
}
