import { describe, it, expect } from 'vitest';
import { parseCSV } from '../core/csv.js';
import { useTempCsv } from './helpers/tempCsv.js';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const { dir } = useTempCsv('csv-enc-');
const write = (name: string, bytes: Buffer) => { const p = join(dir, name); writeFileSync(p, bytes); return p; };

// CURRENT BEHAVIOUR, not endorsed: parseCSV reads bytes and decodes them with
// Buffer#toString('utf8') -- no encoding detection. A Windows-1252 / latin-1
// bank export therefore loses its accented characters. If encoding detection is
// ever added, these tests should be edited consciously.
describe('CSV encoding (current behaviour)', () => {
  it('a latin-1 encoded "CAFÉ" (0xC9) is decoded as U+FFFD replacement char', () => {
    const p = write('latin1.csv', Buffer.concat([Buffer.from('Date,Name,Amount\n2025-01-02,CAF'), Buffer.from([0xc9]), Buffer.from(' NERO,4.50\n')]));
    const parsed = parseCSV(p);
    expect(parsed.rows[0][1]).toBe('CAF� NERO');
    expect(parsed.rows[0][1]).not.toContain('É');
  });

  it('UTF-8 encoded text is preserved', () => {
    const p = write('utf8.csv', Buffer.from('Date,Name,Amount\n2025-01-02,CAFÉ NERO,4.50\n', 'utf8'));
    expect(parseCSV(p).rows[0][1]).toBe('CAFÉ NERO');
  });
});
