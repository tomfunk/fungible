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
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - keepDays);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  for (const file of fs.readdirSync(BACKUP_DIR)) {
    const match = file.match(/^fungible\.(\d{4}-\d{2}-\d{2})\.bak$/);
    if (!match) continue;
    if (match[1] < cutoff) {
      fs.unlinkSync(path.join(BACKUP_DIR, file));
    }
  }
}
