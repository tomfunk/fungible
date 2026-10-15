/**
 * Child process for the cross-process capture test: a second process writes
 * synced tables through the real product modules (core/tags.ts, core/rules.ts),
 * with no knowledge of sync. Spawn via spawnWriter({ script }); do not import.
 *
 * Env: FUNGIBLE_DATA_DIR (temp dir whose fungible.db already has the oplog
 * installed). Prints one JSON line {ok: true} and exits 0.
 */
import { createTag, renameTag } from '../../core/tags.js';
import { saveCategoryRule } from '../../core/rules.js';
import { db } from '../../core/db.js';

await createTag('from-child');
await createTag('child-two');
const r = await db.execute("SELECT id FROM tags WHERE name = 'child-two'");
await renameTag(Number((r.rows[0] as unknown as { id: number }).id), 'child-renamed');
await saveCategoryRule({ matchType: 'name', pattern: 'CHILDMART', category: 'Shopping', minAmount: null, maxAmount: null });
console.log(JSON.stringify({ ok: true }));
process.exit(0);
