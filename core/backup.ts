import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';
import { db } from './db.js';

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
    await db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    await fs.promises.copyFile(DB_PATH, backupPath);
  }

  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => /^fungible\.\d{4}-\d{2}-\d{2}\.bak$/.test(f))
    .sort();

  for (const file of files.slice(0, -keepDays)) {
    fs.unlinkSync(path.join(BACKUP_DIR, file));
  }
}
