// Pure, browser-safe CSV tokenizer (no node imports); extracted from
// balance-import.ts, which re-exports tokenizeCsv.

export type BalanceCsvRecord = { line: number; raw: string; fields: string[] };

/**
 * Quote-aware CSV tokenizer (RFC 4180-ish). Tolerates a BOM, CRLF, lone CR,
 * blank lines and a missing trailing newline. `line` is the 1-based physical
 * line the record starts on; blank lines are dropped but still counted.
 */
export function tokenizeCsvDetailed(text: string): { records: BalanceCsvRecord[]; unterminatedQuoteLine: number | null } {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records: BalanceCsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let quoteStartLine = 0;
  let line = 1;
  let startLine = 1;
  let startIdx = 0;
  let touched = false; // any non-newline content seen in the current record

  const endRecord = (endIdx: number) => {
    fields.push(field);
    const isBlank = fields.length === 1 && fields[0].trim() === '' && !touched;
    if (!isBlank) records.push({ line: startLine, raw: text.slice(startIdx, endIdx), fields });
    fields = [];
    field = '';
    touched = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else {
        if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) line++;
        field += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; quoteStartLine = line; touched = true; }
    else if (c === ',') { fields.push(field); field = ''; touched = true; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord(i);
      line++;
      startLine = line;
      startIdx = i + 1;
    } else { field += c; touched = true; }
  }
  if (touched || field !== '' || fields.length > 0) endRecord(text.length);
  return { records, unterminatedQuoteLine: inQuotes ? quoteStartLine : null };
}

/** Records only; best-effort on an unterminated quote (balance import relies on this). */
export function tokenizeCsv(text: string): BalanceCsvRecord[] {
  return tokenizeCsvDetailed(text).records;
}

