import { db } from './db.js';
import { getSetting, setSetting, SPLIT_JOINT_TAG_KEY, SPLIT_SETTLED_TAG_KEY, SPLIT_PERSONAL_TAG_KEY } from './settings.js';
import { getOrCreateTag, type TagOption } from './tags.js';
import { loadProfile } from './profile.js';
import { isValidIsoDate } from './transactions.js';
import { computeSplit, monthBounds, type SettleMonth, type SplitRatio, type SplitTxRow } from './split-math.js';

// Splitting joint expenses by a ratio and settling up monthly (#310). The math
// lives in split-math.ts; this module reads and writes the database.
//
// Settled state lives in a tag: settling a month tags its joint transactions,
// and what's left to settle comes only from joint transactions without it. No
// copy of the transactions is kept. Ratios can't be back-dated over a settled
// transaction, so a ratio change never moves an amount already settled.
//
// Review: every transaction on either spouse's accounts gets the joint or the
// personal tag. One with neither hasn't been reviewed yet.

export type SplitConfig =
  | { status: 'needs-household' }
  | { status: 'unconfigured'; self: string; spouse: string }
  | {
    status: 'ready'; self: string; spouse: string; jointTag: TagOption; settledTag: TagOption; ratios: SplitRatio[];
    // null for a split set up before review existed; ensurePersonalTag fills it in.
    personalTag: TagOption | null;
  };

/** A month on the Settle up screen: the split math plus how many transactions still need review. */
export type SettleMonthView = SettleMonth & { unreviewed: number };

export async function getRatios(): Promise<SplitRatio[]> {
  const result = await db.execute('SELECT start_date, self_pct FROM split_ratios ORDER BY start_date');
  return (result.rows as unknown as { start_date: string; self_pct: number }[])
    .map((r) => ({ startDate: String(r.start_date), selfPct: Number(r.self_pct) }));
}

async function tagById(id: string | null): Promise<TagOption | null> {
  if (id === null) return null;
  const result = await db.execute({ sql: 'SELECT id, name FROM tags WHERE id = ?', args: [Number(id)] });
  const row = result.rows[0] as unknown as { id: number; name: string } | undefined;
  return row ? { id: Number(row.id), name: String(row.name) } : null;
}

/**
 * The split needs both self and spouse named in the household profile, both
 * tags, and at least one ratio. A configured tag that has since been deleted
 * puts the split back to unconfigured.
 */
export async function getSplitConfig(): Promise<SplitConfig> {
  const profile = await loadProfile();
  const self = profile?.self.name.trim() ?? '';
  const spouse = profile?.spouse?.name.trim() ?? '';
  if (!self || !spouse) return { status: 'needs-household' };
  const jointTag = await tagById(await getSetting(SPLIT_JOINT_TAG_KEY));
  const settledTag = await tagById(await getSetting(SPLIT_SETTLED_TAG_KEY));
  const ratios = await getRatios();
  if (!jointTag || !settledTag || ratios.length === 0) return { status: 'unconfigured', self, spouse };
  const personalTag = await tagById(await getSetting(SPLIT_PERSONAL_TAG_KEY));
  return { status: 'ready', self, spouse, jointTag, settledTag, ratios, personalTag };
}

/** How many transactions already carry a tag with this name (0 when no such tag exists). */
export async function countTransactionsTagged(tagName: string): Promise<number> {
  const result = await db.execute({
    sql: 'SELECT COUNT(*) AS n FROM transaction_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tg.name = ?',
    args: [tagName.trim()],
  });
  return Number((result.rows[0] as unknown as { n: number }).n);
}

async function latestSettledDate(settledTagId: number | null): Promise<string | null> {
  if (settledTagId === null) return null;
  const result = await db.execute({
    sql: `SELECT MAX(t.date) AS latest FROM transactions t
          JOIN transaction_tags tt ON tt.transaction_id = t.id
          WHERE tt.tag_id = ?`,
    args: [settledTagId],
  });
  const latest = (result.rows[0] as unknown as { latest: string | null } | undefined)?.latest;
  return latest ?? null;
}

function checkRatio(startDate: string, selfPct: number): void {
  if (!isValidIsoDate(startDate)) throw new Error('Start date must be a real date in YYYY-MM-DD form');
  if (!Number.isFinite(selfPct) || selfPct < 0 || selfPct > 100) throw new Error('Percentage must be between 0 and 100');
}

// A ratio change on or before the latest settled transaction would change an
// amount that has already been paid.
async function assertNotBackdated(settledTagId: number | null, dates: string[]): Promise<void> {
  const latest = await latestSettledDate(settledTagId);
  if (latest !== null && dates.some((d) => d <= latest)) {
    throw new Error(`Ratios can't change on or before ${latest}, the date of the latest settled transaction`);
  }
}

async function configuredSettledTagId(): Promise<number | null> {
  const id = await getSetting(SPLIT_SETTLED_TAG_KEY);
  return id === null ? null : Number(id);
}

async function ratioExists(startDate: string): Promise<boolean> {
  const result = await db.execute({ sql: 'SELECT 1 FROM split_ratios WHERE start_date = ?', args: [startDate] });
  return result.rows.length > 0;
}

export const DEFAULT_PERSONAL_TAG = 'personal';

/**
 * First-time setup: picks (or creates) the three tags and saves the first ratio.
 * Running it again after a tag was deleted re-points the tags and upserts the
 * ratio, still refusing to back-date over a settled transaction.
 */
export async function setupSplit(opts: {
  jointTagName: string; settledTagName: string; personalTagName?: string; selfPct: number; startDate: string;
}): Promise<void> {
  const jointName = opts.jointTagName.trim();
  const settledName = opts.settledTagName.trim();
  const personalName = (opts.personalTagName ?? DEFAULT_PERSONAL_TAG).trim();
  if (!jointName || !settledName || !personalName) throw new Error('All three tag names are required');
  if (new Set([jointName, settledName, personalName]).size < 3) throw new Error('The joint, personal and settled tags must all be different');
  checkRatio(opts.startDate, opts.selfPct);
  const existing = await db.execute({ sql: 'SELECT id FROM tags WHERE name = ?', args: [settledName] });
  const existingSettledId = existing.rows[0] ? Number((existing.rows[0] as unknown as { id: number }).id) : null;
  await assertNotBackdated(existingSettledId, [opts.startDate]);

  const jointId = await getOrCreateTag(jointName);
  const settledId = existingSettledId ?? await getOrCreateTag(settledName);
  const personalId = await getOrCreateTag(personalName);
  const upsertSetting = 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';
  await db.batch([
    { sql: upsertSetting, args: [SPLIT_JOINT_TAG_KEY, String(jointId)] },
    { sql: upsertSetting, args: [SPLIT_SETTLED_TAG_KEY, String(settledId)] },
    { sql: upsertSetting, args: [SPLIT_PERSONAL_TAG_KEY, String(personalId)] },
    {
      sql: `INSERT INTO split_ratios (start_date, self_pct) VALUES (?, ?)
            ON CONFLICT(start_date) DO UPDATE SET self_pct = excluded.self_pct`,
      args: [opts.startDate, opts.selfPct],
    },
  ], 'write');
}

/** The personal tag, creating `personal` for a split set up before review existed. */
export async function ensurePersonalTag(): Promise<TagOption> {
  const existing = await tagById(await getSetting(SPLIT_PERSONAL_TAG_KEY));
  if (existing) return existing;
  const id = await getOrCreateTag(DEFAULT_PERSONAL_TAG);
  await setSetting(SPLIT_PERSONAL_TAG_KEY, String(id));
  return { id, name: DEFAULT_PERSONAL_TAG };
}

export async function addRatio(startDate: string, selfPct: number): Promise<void> {
  checkRatio(startDate, selfPct);
  await assertNotBackdated(await configuredSettledTagId(), [startDate]);
  if (await ratioExists(startDate)) throw new Error(`A ratio already starts on ${startDate}`);
  await db.execute({ sql: 'INSERT INTO split_ratios (start_date, self_pct) VALUES (?, ?)', args: [startDate, selfPct] });
}

export async function updateRatio(oldStartDate: string, startDate: string, selfPct: number): Promise<void> {
  checkRatio(startDate, selfPct);
  await assertNotBackdated(await configuredSettledTagId(), [oldStartDate, startDate]);
  if (startDate !== oldStartDate && await ratioExists(startDate)) throw new Error(`A ratio already starts on ${startDate}`);
  await db.execute({
    sql: 'UPDATE split_ratios SET start_date = ?, self_pct = ? WHERE start_date = ?',
    args: [startDate, selfPct, oldStartDate],
  });
}

export async function deleteRatio(startDate: string): Promise<void> {
  await assertNotBackdated(await configuredSettledTagId(), [startDate]);
  if ((await getRatios()).length <= 1) throw new Error("Can't delete the only ratio");
  await db.execute({ sql: 'DELETE FROM split_ratios WHERE start_date = ?', args: [startDate] });
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Every month from the first ratio's start, newest first. Reads each
 * transaction carrying the joint or settled tag (pending ones too, for the
 * warning) with its account owner and whether its category is hidden; the
 * math decides what counts. Empty until the split is configured.
 */
export async function getSettleMonths(today: string = localToday()): Promise<SettleMonthView[]> {
  const config = await getSplitConfig();
  if (config.status !== 'ready') return [];
  const jointId = config.jointTag.id;
  const settledId = config.settledTag.id;
  const result = await db.execute({
    sql: `SELECT t.id, t.date, t.amount, t.pending, t.ignored,
            NULLIF(TRIM(a.owner), '') AS owner,
            EXISTS (SELECT 1 FROM transaction_tags j WHERE j.transaction_id = t.id AND j.tag_id = ?) AS joint,
            EXISTS (SELECT 1 FROM transaction_tags s WHERE s.transaction_id = t.id AND s.tag_id = ?) AS settled,
            EXISTS (SELECT 1 FROM hidden_categories h WHERE h.category = t.category) AS hidden
          FROM transactions t
          LEFT JOIN accounts a ON a.id = t.account_id
          WHERE t.date >= ?
            AND t.id IN (SELECT transaction_id FROM transaction_tags WHERE tag_id IN (?, ?))
          ORDER BY t.date, t.id`,
    args: [jointId, settledId, config.ratios[0].startDate, jointId, settledId],
  });
  const rows: SplitTxRow[] = (result.rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    date: String(r.date),
    amount: Number(r.amount),
    owner: r.owner === null ? null : String(r.owner),
    joint: Boolean(r.joint),
    settled: Boolean(r.settled),
    pending: Boolean(r.pending),
    ignored: Boolean(r.ignored),
    hidden: Boolean(r.hidden),
  }));
  const counts = await db.execute({
    sql: `SELECT substr(t.date, 1, 7) AS month, COUNT(*) AS n
          FROM transactions t JOIN accounts a ON a.id = t.account_id
          WHERE ${UNREVIEWED_WHERE}
          GROUP BY month`,
    args: unreviewedArgs(config),
  });
  const unreviewed = new Map((counts.rows as unknown as { month: string; n: number }[]).map((r) => [String(r.month), Number(r.n)]));
  return computeSplit(rows, config.ratios, { self: config.self, spouse: config.spouse }, today)
    .map((m) => ({ ...m, unreviewed: unreviewed.get(m.month) ?? 0 }));
}

// Needs review: a posted, not-ignored transaction on either spouse's account,
// on or after the first ratio, outside hidden categories (card payments and
// transfers), with neither the joint nor the personal tag. Income and refunds
// count too. Pending ones wait until they post, since a posted transaction can
// arrive under a new id.
const UNREVIEWED_WHERE = `t.date >= ? AND t.pending = 0 AND t.ignored = 0
            AND TRIM(a.owner) IN (?, ?)
            AND NOT EXISTS (SELECT 1 FROM hidden_categories h WHERE h.category = t.category)
            AND NOT EXISTS (SELECT 1 FROM transaction_tags x WHERE x.transaction_id = t.id AND x.tag_id IN (?, ?))`;

function unreviewedArgs(config: Ready): (string | number)[] {
  return [config.ratios[0].startDate, config.self, config.spouse, config.jointTag.id, config.personalTag?.id ?? -1];
}

type Ready = Extract<SplitConfig, { status: 'ready' }>;

async function requireReady(): Promise<Ready> {
  const config = await getSplitConfig();
  if (config.status !== 'ready') throw new Error('Expense split is not set up');
  return config;
}

export type ReviewTx = {
  id: string;
  date: string;
  name: string;
  amount: number;
  category: string | null;
  manualCategory: string | null;
  account: string;
  owner: string;
};

/** A YYYY-MM month's transactions that still need review, oldest first. */
export async function getReviewQueue(month: string): Promise<ReviewTx[]> {
  const config = await requireReady();
  const { from, to } = monthBounds(month);
  const result = await db.execute({
    sql: `SELECT t.id, t.date, COALESCE(t.display_name, t.merchant_name, t.name) AS name, t.amount,
            t.category, t.manual_category, COALESCE(a.nickname, a.name) AS account, TRIM(a.owner) AS owner
          FROM transactions t JOIN accounts a ON a.id = t.account_id
          WHERE ${UNREVIEWED_WHERE} AND t.date >= ? AND t.date <= ?
          ORDER BY t.date, t.id`,
    args: [...unreviewedArgs(config), from, to],
  });
  return (result.rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    date: String(r.date),
    name: String(r.name),
    amount: Number(r.amount),
    category: r.category === null ? null : String(r.category),
    manualCategory: r.manual_category === null ? null : String(r.manual_category),
    account: String(r.account),
    owner: String(r.owner),
  }));
}

/**
 * Record a review answer: tag the transaction joint or personal (or neither,
 * for a skip) and, when `category` is given, override its category, in one
 * batch. Tag-rule suppressions are left alone so undoReview can put things
 * back exactly.
 */
export async function reviewTransaction(id: string, answer: 'joint' | 'personal' | null, category: string | null): Promise<void> {
  const config = await requireReady();
  const tagId = answer === 'joint' ? config.jointTag.id : answer === 'personal' ? (await ensurePersonalTag()).id : null;
  const stmts = [
    ...(tagId === null ? [] : [{ sql: 'INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', args: [id, tagId] }]),
    ...(category === null ? [] : [{ sql: 'UPDATE transactions SET category = ?, manual_category = ? WHERE id = ?', args: [category, category, id] }]),
  ];
  if (stmts.length > 0) await db.batch(stmts, 'write');
}

/** Undo a review answer: remove its tag and restore the category the transaction had before. */
export async function undoReview(tx: Pick<ReviewTx, 'id' | 'category' | 'manualCategory'>, answer: 'joint' | 'personal' | null): Promise<void> {
  const config = await requireReady();
  const tagId = answer === 'joint' ? config.jointTag.id : answer === 'personal' ? config.personalTag?.id ?? null : null;
  const stmts = [
    ...(tagId === null ? [] : [{ sql: 'DELETE FROM transaction_tags WHERE transaction_id = ? AND tag_id = ?', args: [tx.id, tagId] }]),
    { sql: 'UPDATE transactions SET category = ?, manual_category = ? WHERE id = ?', args: [tx.category, tx.manualCategory, tx.id] },
  ];
  await db.batch(stmts, 'write');
}

async function requireSettledTagId(): Promise<number> {
  return (await requireReady()).settledTag.id;
}

/**
 * Settle a month: tag exactly the transactions the confirmation showed, and
 * untag the settled ones that no longer count. Taking ids (not a month) means
 * a sync that lands between the prompt and the answer can't slip transactions
 * into a settlement nobody saw. One batch, so it's all or nothing.
 */
export async function settleMonth(tagIds: string[], untagIds: string[]): Promise<void> {
  const settledId = await requireSettledTagId();
  const stmts = [
    ...tagIds.map((id) => ({ sql: 'INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', args: [id, settledId] })),
    ...untagIds.map((id) => ({ sql: 'DELETE FROM transaction_tags WHERE transaction_id = ? AND tag_id = ?', args: [id, settledId] })),
  ];
  if (stmts.length > 0) await db.batch(stmts, 'write');
}

/** Undo: remove the settled tag from every transaction in a YYYY-MM month. */
export async function unsettleMonth(month: string): Promise<void> {
  const settledId = await requireSettledTagId();
  const { from, to } = monthBounds(month);
  await db.execute({
    sql: `DELETE FROM transaction_tags WHERE tag_id = ?
            AND transaction_id IN (SELECT id FROM transactions WHERE date >= ? AND date <= ?)`,
    args: [settledId, from, to],
  });
}
