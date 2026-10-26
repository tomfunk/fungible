import { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  getSplitConfig, getSettleMonths, setupSplit, settleMonth, unsettleMonth, countTransactionsTagged,
  addRatio, updateRatio, deleteRatio, getReviewQueue, reviewTransaction, undoReview,
  type SplitConfig, type SettleMonthView, type ReviewTx,
} from '../core/split.js';
import type { SettleMonth, RatioSlice } from '../core/split-math.js';
import { getAllCategories } from '../core/queries.js';
import { MONTHS } from '../core/dateUtils.js';
import type { Screen, TxFilter } from './App.js';
import { fmt, truncate, Divider } from './fmt.js';
import { handleNavKey } from './nav.js';
import { useTerminalWidth, C_POSITIVE, C_NEGATIVE, C_WARNING, C_ACCENT } from './ui.js';
import { PageHeader, ModalPanel, SelectableRow, SectionHeader, EditTextField, EditToggleField, useStatusMessage, usePagination } from './components/index.js';
import { useSetTyping } from './TypingContext.js';
import { useRefreshKey } from './RefreshContext.js';
import { useFilter } from './FilterContext.js';
import { useLoadError, LoadError } from './useLoadError.js';
import { useLoadGuard } from './useLoadGuard.js';

// Settle up (#310): split joint-tagged expenses by a ratio and settle each
// calendar month. Opened with [s] from the Dashboard's Owner view; runs setup
// first when the split isn't configured yet.

type Mode = 'list' | 'setup' | 'confirm-settle' | 'confirm-unsettle' | 'ratios' | 'ratio-edit' | 'review';
type Ready = Extract<SplitConfig, { status: 'ready' }>;
type Answer = 'joint' | 'personal' | null;

const SETUP_FIELDS = ['joint', 'personal', 'settled', 'pct', 'start'] as const;
type SetupField = typeof SETUP_FIELDS[number];
const SETUP_LABELS: Record<SetupField, string> = {
  joint: 'Joint tag', personal: 'Personal tag', settled: 'Settled tag', pct: 'Your share %', start: 'Starts',
};
// Characters each setup field accepts as you type.
const SETUP_CHARS: Partial<Record<SetupField, RegExp>> = { pct: /^[0-9.]$/, start: /^[0-9-]$/ };

const RATIO_FIELDS = ['start', 'pct'] as const;
type RatioField = typeof RATIO_FIELDS[number];

function firstOfMonth(offset = 0): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
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

const categoryOf = (tx: ReviewTx) => tx.category ?? 'Uncategorized';

const STATUS_LABEL: Record<SettleMonth['status'], string> = { empty: '—', open: 'open', settled: 'settled', 'top-up': 'top-up' };
const MONTH_PAGE = 12;

export function Settle({ onNavigate, isActive, initialFilter, showHints }: { onNavigate: (s: Screen, f?: TxFilter) => void; isActive?: boolean; initialFilter?: TxFilter; showHints: boolean }) {
  const { loadError, track } = useLoadError();
  const refreshKey = useRefreshKey();
  const { setFilter } = useFilter();
  const guard = useLoadGuard();
  const { statusMsg, showStatus } = useStatusMessage(3000);
  const [config, setConfig] = useState<SplitConfig | null>(null);
  const [months, setMonths] = useState<SettleMonthView[]>([]);
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>('list');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [setup, setSetup] = useState<Record<SetupField, string>>({ joint: 'joint', personal: 'personal', settled: 'settled', pct: '', start: firstOfMonth() });
  const [setupField, setSetupField] = useState(0);
  // Set once the settled tag name was found already on transactions; a second Enter proceeds.
  const [setupWarned, setSetupWarned] = useState<string | null>(null);

  // Ratio list ([r]): newest first. ratioEditing is the start date being edited, null for a new one.
  const [ratioCursor, setRatioCursor] = useState(0);
  const [ratioForm, setRatioForm] = useState<Record<RatioField, string>>({ start: '', pct: '' });
  const [ratioField, setRatioField] = useState(0);
  const [ratioEditing, setRatioEditing] = useState<string | null>(null);

  // Review ([v]): one month's unreviewed transactions, oldest first, answered
  // one at a time. answers holds each answer's queue index, for undo.
  const [reviewMonth, setReviewMonth] = useState<string | null>(null);
  const [queue, setQueue] = useState<ReviewTx[]>([]);
  const [reviewIdx, setReviewIdx] = useState(0);
  const [categories, setCategories] = useState<string[]>([]);
  const [catIdx, setCatIdx] = useState(0);
  const [answers, setAnswers] = useState<{ idx: number; answer: Answer }[]>([]);
  // Opened from the settle prompt: finishing returns to that prompt.
  const [reviewFromSettle, setReviewFromSettle] = useState(false);
  // Marking a transaction in a settled month joint waits for a y/n.
  const [jointConfirm, setJointConfirm] = useState(false);

  const initialCursorDone = useRef(false);
  function load() { void loadMonths(); }
  function loadMonths(): Promise<SettleMonthView[] | null> {
    const token = guard.begin();
    return track(Promise.all([getSplitConfig(), getSettleMonths()])).then(([c, ms]) => {
      if (!guard.isLatest(token)) return null;
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
      return ms;
    });
  }
  useEffect(load, [refreshKey]);

  const setTyping = useSetTyping();
  useEffect(() => {
    setTyping(mode === 'setup' || mode === 'ratio-edit');
    return () => setTyping(false);
  }, [mode]);

  const ready = config?.status === 'ready' ? config : null;
  const month = months[cursor];
  const ratiosDesc = ready ? [...ready.ratios].reverse() : [];

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
        personalTagName: setup.personal,
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

  async function saveRatio() {
    setError(null);
    const start = ratioForm.start.trim();
    const selfPct = ratioForm.pct.trim() === '' ? Number.NaN : Number(ratioForm.pct);
    setBusy(true);
    try {
      if (ratioEditing === null) await addRatio(start, selfPct);
      else await updateRatio(ratioEditing, start, selfPct);
      setMode('ratios');
      showStatus(ratioEditing === null ? `Added the ratio starting ${start}` : `Updated the ratio starting ${start}`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeRatio(startDate: string) {
    setError(null);
    setBusy(true);
    try {
      await deleteRatio(startDate);
      setRatioCursor((c) => Math.max(0, c - 1));
      showStatus(`Deleted the ratio starting ${startDate}`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startReview(m: SettleMonthView, fromSettle: boolean) {
    setError(null);
    setBusy(true);
    try {
      const [q, cats] = await Promise.all([getReviewQueue(m.month), getAllCategories()]);
      if (q.length === 0) { setMode('list'); showStatus(`Nothing to review in ${longMonth(m.month)}`); return; }
      // A transaction's category may not be in the categories table (e.g. Uncategorized).
      const all = [...new Set([...cats, ...q.map(categoryOf)])].sort((a, b) => a.localeCompare(b));
      setCategories(all);
      setQueue(q);
      setReviewMonth(m.month);
      setReviewIdx(0);
      setCatIdx(all.indexOf(categoryOf(q[0])));
      setAnswers([]);
      setReviewFromSettle(fromSettle);
      setJointConfirm(false);
      setMode('review');
    } catch (err) {
      setMode('list');
      setError(`Could not start review: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function finishReview(stopped: boolean, done = answers) {
    const label = longMonth(reviewMonth!);
    const marked = done.filter((a) => a.answer !== null).length;
    const skipped = done.length - marked;
    setMode('list');
    showStatus(`${stopped ? 'Stopped reviewing' : 'Reviewed'} ${label}: ${marked} marked${skipped > 0 ? `, ${skipped} skipped` : ''}`);
    const ms = await loadMonths();
    if (stopped || !reviewFromSettle || !ms) return;
    const idx = ms.findIndex((x) => x.month === reviewMonth);
    const m = ms[idx];
    if (m && m.blockedIds.length === 0 && m.tagIds.length + m.untagIds.length > 0) {
      setCursor(idx);
      setMode('confirm-settle');
    }
  }

  async function answer(a: Answer) {
    const tx = queue[reviewIdx];
    setJointConfirm(false);
    setError(null);
    setBusy(true);
    try {
      const chosen = categories[catIdx];
      await reviewTransaction(tx.id, a, chosen !== undefined && chosen !== categoryOf(tx) ? chosen : null);
      const done = [...answers, { idx: reviewIdx, answer: a }];
      setAnswers(done);
      const next = reviewIdx + 1;
      if (next >= queue.length) { await finishReview(false, done); return; }
      setReviewIdx(next);
      setCatIdx(categories.indexOf(categoryOf(queue[next])));
    } catch (err) {
      setError(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function undoAnswer() {
    const last = answers[answers.length - 1];
    if (!last) { showStatus('Nothing to undo'); return; }
    setError(null);
    setBusy(true);
    try {
      await undoReview(queue[last.idx], last.answer);
      setAnswers(answers.slice(0, -1));
      setReviewIdx(last.idx);
      setCatIdx(categories.indexOf(categoryOf(queue[last.idx])));
    } catch (err) {
      setError(`Could not undo: ${err instanceof Error ? err.message : String(err)}`);
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

    if (mode === 'review') {
      if (jointConfirm) {
        if (input === 'y') { void answer('joint'); return; }
        if (input === 'n' || key.escape) { setJointConfirm(false); return; }
        return;
      }
      if (key.escape) { void finishReview(true); return; }
      if (key.leftArrow) { setCatIdx((i) => (i - 1 + categories.length) % categories.length); return; }
      if (key.rightArrow) { setCatIdx((i) => (i + 1) % categories.length); return; }
      if (input === 'j') {
        const m = months.find((x) => x.month === reviewMonth);
        if (m && (m.status === 'settled' || m.status === 'top-up')) { setJointConfirm(true); return; }
        void answer('joint');
        return;
      }
      if (input === 'p') { void answer('personal'); return; }
      if (input === 'k') { void answer(null); return; }
      if (input === 'z') { void undoAnswer(); return; }
      return;
    }

    if (mode === 'confirm-settle' || mode === 'confirm-unsettle') {
      if (!month || !ready) { setMode('list'); return; }
      if (mode === 'confirm-settle' && input === 'v' && month.unreviewed > 0) { void startReview(month, true); return; }
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

    if (mode === 'ratio-edit') {
      const field = RATIO_FIELDS[ratioField];
      if (key.escape) { setError(null); setMode('ratios'); return; }
      if (key.upArrow) { setRatioField(0); return; }
      if (key.downArrow || key.tab) { setRatioField(1); return; }
      if (key.return) { void saveRatio(); return; }
      if (key.backspace || key.delete) { setRatioForm((f) => ({ ...f, [field]: f[field].slice(0, -1) })); return; }
      if (input && !key.ctrl && !key.meta) {
        const allowed = SETUP_CHARS[field]!;
        const typed = [...input].filter((ch) => allowed.test(ch)).join('');
        if (typed) setRatioForm((f) => ({ ...f, [field]: f[field] + typed }));
      }
      return;
    }

    if (mode === 'ratios') {
      if (key.escape) { setError(null); setMode('list'); return; }
      if (handleNavKey(input, 'settle', onNavigate)) return;
      const selected = ratiosDesc[ratioCursor];
      if (key.upArrow) { setRatioCursor((c) => Math.max(0, c - 1)); setError(null); return; }
      if (key.downArrow) { setRatioCursor((c) => Math.min(ratiosDesc.length - 1, c + 1)); setError(null); return; }
      if (input === 'a') {
        setError(null);
        setRatioEditing(null);
        setRatioForm({ start: firstOfMonth(1), pct: ratiosDesc[0] ? String(ratiosDesc[0].selfPct) : '' });
        setRatioField(0);
        setMode('ratio-edit');
        return;
      }
      if (key.return && selected) {
        setError(null);
        setRatioEditing(selected.startDate);
        setRatioForm({ start: selected.startDate, pct: String(selected.selfPct) });
        setRatioField(0);
        setMode('ratio-edit');
        return;
      }
      if (input === 'x' && selected) { void removeRatio(selected.startDate); return; }
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
      if (month.tagIds.length === 0 && month.untagIds.length === 0) {
        showStatus(month.unreviewed > 0
          ? `Nothing to settle for ${longMonth(month.month)} yet: ${plural(month.unreviewed, 'transaction')} to review with [v]`
          : `Nothing to settle for ${longMonth(month.month)}`);
        return;
      }
      setMode('confirm-settle');
      return;
    }
    if (input === 'v') { void startReview(month, false); return; }
    if (input === 'u') {
      setError(null);
      if (month.status !== 'settled' && month.status !== 'top-up') { showStatus(`Nothing settled in ${longMonth(month.month)}`); return; }
      setMode('confirm-unsettle');
      return;
    }
    if (input === 'r') { setError(null); setRatioCursor(0); setMode('ratios'); return; }
  }, { isActive: isActive !== false });

  const termW = useTerminalWidth();
  const inner = Math.max(60, termW) - 4;
  const nameW = 8;
  // [sel=2] [month=8] [joint=9] [self=8] [spouse=8] [to settle] [status=7] [review=6], gaps of 2
  const settleW = Math.max(18, Math.min(28, inner - 63));
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
        <Text dimColor>{showHints ? '↑↓ month  ·  Enter joint txns  ·  [v] review  ·  [s] settle  ·  [u] unsettle  ·  [r] ratios  ·  Esc back' : '[v] review  ·  [s] settle  ·  [u] unsettle  ·  [r] ratios'}</Text>
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
      ) : ready && (mode === 'ratios' || mode === 'ratio-edit') ? (
        <ModalPanel title="Split ratios">
          <Text dimColor>Each transaction uses the ratio in effect on its date. Ratios can't change on or before a settled transaction.</Text>
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{'  '}{'Starts'.padEnd(12)}  {truncate(ready.self, nameW).padStart(nameW)}  {truncate(ready.spouse, nameW).padStart(nameW)}</Text>
            {ratiosDesc.map((r, i) => {
              const sel = mode === 'ratios' && i === ratioCursor;
              return (
                <SelectableRow key={r.startDate} selected={sel}>
                  <Text color={sel ? C_ACCENT : undefined}>{r.startDate.padEnd(12)}</Text>
                  <Text>{pct(r.selfPct).padStart(nameW)}</Text>
                  <Text>{pct(100 - r.selfPct).padStart(nameW)}</Text>
                </SelectableRow>
              );
            })}
          </Box>
          {mode === 'ratio-edit' ? (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>{ratioEditing === null ? 'New ratio' : `Edit the ratio starting ${ratioEditing}`}</Text>
              <EditTextField label="Starts" labelWidth={13} active={ratioField === 0} value={ratioForm.start} color={C_WARNING} placeholder="YYYY-MM-DD" />
              <EditTextField label="Your share %" labelWidth={13} active={ratioField === 1} value={ratioForm.pct} color={C_WARNING} placeholder="e.g. 60" />
              <Text dimColor>↑↓ field  ·  Enter save  ·  Esc cancel</Text>
            </Box>
          ) : (
            <Box marginTop={1}><Text dimColor>[a] add  ·  Enter edit  ·  [x] delete  ·  Esc back</Text></Box>
          )}
          {error && <Text color={C_NEGATIVE}>{error}</Text>}
          {statusMsg && <Text color={C_POSITIVE}>{statusMsg}</Text>}
        </ModalPanel>
      ) : ready && mode === 'review' && queue[reviewIdx] ? (
        <ReviewPanel
          tx={queue[reviewIdx]} position={reviewIdx + 1} total={queue.length} month={reviewMonth!}
          category={categories[catIdx] ?? categoryOf(queue[reviewIdx])}
          settled={months.some((m) => m.month === reviewMonth && (m.status === 'settled' || m.status === 'top-up'))}
          jointConfirm={jointConfirm} error={error} statusMsg={statusMsg}
        />
      ) : ready && (
        <>
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>
              {'  '}{'Month'.padEnd(8)}  {'Joint'.padStart(9)}  {truncate(ready.self, nameW).padStart(nameW)}  {truncate(ready.spouse, nameW).padStart(nameW)}  {'To settle'.padEnd(settleW)}  {'Status'.padEnd(7)}  Review
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
                    {(blocked ? 'blocked' : STATUS_LABEL[m.status]).padEnd(7)}
                  </Text>
                  <Text color={m.unreviewed > 0 ? C_WARNING : undefined} dimColor={m.unreviewed === 0}>
                    {m.unreviewed > 0 ? String(m.unreviewed).padStart(6) : '—'.padStart(6)}
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
              {month.unreviewed > 0 && <Text color={C_WARNING}>⚠ {plural(month.unreviewed, 'transaction')} in {longMonth(month.month)} not reviewed yet</Text>}
              <Box marginTop={1}>
                <Text dimColor>{month.unreviewed > 0 ? '[v] review first  ·  [y] settle anyway  ·  [n] cancel' : '[y] settle  ·  [n] cancel'}</Text>
              </Box>
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

function MonthDetail({ m, c }: { m: SettleMonthView; c: Ready }) {
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
        {m.unreviewed > 0 && <Text color={C_WARNING}>⚠ {plural(m.unreviewed, 'transaction')} not reviewed as joint or personal yet ([v] review)</Text>}
        {m.pendingCount > 0 && <Text color={C_WARNING}>⚠ {plural(m.pendingCount, 'joint transaction')} still pending</Text>}
        {m.inProgress && <Text color={C_WARNING}>⚠ {monthName(m.month)} isn't over yet</Text>}
        {m.hiddenCount > 0 && <Text dimColor>· {plural(m.hiddenCount, 'joint-tagged transaction')} left out (hidden category)</Text>}
        {m.untagIds.length > 0 && <Text dimColor>· {plural(m.untagIds.length, 'settled transaction')} no longer {m.untagIds.length === 1 ? 'counts' : 'count'} and will be reversed</Text>}
      </Box>
    </Box>
  );
}

function ReviewPanel({ tx, position, total, month, category, settled, jointConfirm, error, statusMsg }: {
  tx: ReviewTx; position: number; total: number; month: string; category: string;
  settled: boolean; jointConfirm: boolean; error: string | null; statusMsg: string;
}) {
  const line = (label: string, value: string) => (
    <Box gap={2}><Text dimColor>{label.padEnd(10)}</Text><Text>{value}</Text></Box>
  );
  // Positive amounts are money out; income and refunds come in negative.
  const amount = tx.amount >= 0 ? fmt(tx.amount) : `${fmt(-tx.amount)} in (income or refund)`;
  return (
    <ModalPanel title={`Review ${longMonth(month)}  ·  ${position} of ${total}`}>
      <Box flexDirection="column">
        {line('Account', `${tx.account} (${tx.owner})`)}
        {line('Date', `${dayLabel(tx.date)}, ${tx.date.slice(0, 4)}`)}
        {line('Merchant', tx.name)}
        {line('Amount', amount)}
        <EditToggleField label="Category" labelWidth={10} active value={category} valueColor={category !== categoryOf(tx) ? C_WARNING : undefined} />
      </Box>
      {jointConfirm ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={C_WARNING}>{longMonth(month)} is already settled, so marking this joint makes it a top-up.</Text>
          <Text dimColor>[y] mark joint  ·  [n] cancel</Text>
        </Box>
      ) : (
        <Box marginTop={1}><Text dimColor>[j] joint  ·  [p] personal  ·  ← → category  ·  [k] skip  ·  [z] undo  ·  Esc stop</Text></Box>
      )}
      {settled && !jointConfirm && <Text dimColor>{longMonth(month)} is settled: anything marked joint will be a top-up.</Text>}
      {error && <Text color={C_NEGATIVE}>{error}</Text>}
      {statusMsg && <Text color={C_POSITIVE}>{statusMsg}</Text>}
    </ModalPanel>
  );
}
