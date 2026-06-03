import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

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
    await fs.promises.copyFile(DB_PATH, backupPath);
    // Copy WAL and SHM alongside so SQLite can replay all committed data when
    // the backup is opened. The main .db file may lag behind by days in WAL mode.
    for (const suffix of ['-wal', '-shm']) {
      const src = `${DB_PATH}${suffix}`;
      if (fs.existsSync(src)) {
        await fs.promises.copyFile(src, `${backupPath}${suffix}`);
      }
    }
  }

  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => /^fungible\.\d{4}-\d{2}-\d{2}\.bak$/.test(f))
    .sort();

  for (const file of files.slice(0, -keepDays)) {
    const base = path.join(BACKUP_DIR, file);
    fs.unlinkSync(base);
    for (const suffix of ['-wal', '-shm']) {
      const side = `${base}${suffix}`;
      if (fs.existsSync(side)) fs.unlinkSync(side);
    }
  }
}
