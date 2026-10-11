import { describe, it, expect } from 'vitest';
import { parseCSV } from '../core/csv.js';
import { useTempCsv } from './helpers/tempCsv.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { dir } = useTempCsv('csv-enc-');
const write = (name: string, bytes: Buffer) => { const p = join(dir, name); writeFileSync(p, bytes); return p; };

describe('CSV encoding', () => {
  it('a Windows-1252 "CAFÉ" (0xC9) falls back and decodes correctly', () => {
    const p = write('latin1.csv', Buffer.concat([Buffer.from('Date,Name,Amount\n2025-01-02,CAF'), Buffer.from([0xc9]), Buffer.from(' NERO,4.50\n')]));
    expect(parseCSV(p).rows[0][1]).toBe('CAFÉ NERO');
  });

  it('a Windows-1252 curly apostrophe (0x92) decodes to U+2019', () => {
    const p = write('cp1252.csv', Buffer.concat([Buffer.from('Date,Name,Amount\n2025-01-02,JOE'), Buffer.from([0x92]), Buffer.from('S,4.50\n')]));
    expect(parseCSV(p).rows[0][1]).toBe('JOE’S');
  });

  it('UTF-8 encoded text is preserved', () => {
    const p = write('utf8.csv', Buffer.from('Date,Name,Amount\n2025-01-02,CAFÉ NERO,4.50\n', 'utf8'));
    expect(parseCSV(p).rows[0][1]).toBe('CAFÉ NERO');
  });
});
