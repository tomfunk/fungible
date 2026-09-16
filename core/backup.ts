import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';
import { db } from './db.js';
import { KEY_FILE_PATH } from './crypto.js';
import { getSetting, BACKUP_INCLUDE_KEY_KEY } from './settings.js';

const DB_PATH = path.join(DATA_DIR, 'fungible.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

export async function backupDb(): Promise<void> {
  const keepDays = parseInt(process.env.FUNGIBLE_BACKUP_DAYS ?? '7', 10);
  if (isNaN(keepDays) || keepDays <= 0) return;

  if (!fs.existsSync(DB_PATH)) return;

  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const backupPath = path.join(BACKUP_DIR, `fungible.${today}.bak`);

  if (!fs.existsSync(backupPath)) {
    await db.execute({ sql: 'VACUUM INTO ?', args: [backupPath] });
  }

  // Opt-in only: bundling the decryption key with the encrypted data it
  // protects defeats the point of encrypting backups for anyone whose backup
  // folder leaves the machine (cloud sync, external drive, NAS). See #179.
  const includeKey = (await getSetting(BACKUP_INCLUDE_KEY_KEY)) === 'true';
  if (includeKey && fs.existsSync(KEY_FILE_PATH)) {
    const keyBackupPath = path.join(BACKUP_DIR, `key.${today}.bak`);
    if (!fs.existsSync(keyBackupPath)) {
      fs.copyFileSync(KEY_FILE_PATH, keyBackupPath);
      // copyFileSync doesn't preserve mode; the source key file is 0o600 and
      // the copy must stay that restrictive.
      fs.chmodSync(keyBackupPath, 0o600);
    }
  }

  // Pruned separately per prefix (not combined-then-sliced): sorting the two
  // filename families together as plain strings would interleave them out of
  // date order ("fungible." < "key." lexically regardless of date), which
  // would prune the wrong files.
  const allFiles = fs.readdirSync(BACKUP_DIR);
  for (const pattern of [/^fungible\.\d{4}-\d{2}-\d{2}\.bak$/, /^key\.\d{4}-\d{2}-\d{2}\.bak$/]) {
    const files = allFiles.filter(f => pattern.test(f)).sort();
    for (const file of files.slice(0, -keepDays)) {
      fs.unlinkSync(path.join(BACKUP_DIR, file));
    }
  }
}
