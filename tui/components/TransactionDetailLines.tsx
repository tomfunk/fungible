import { Box, Text } from 'ink';
import type { TransactionDetail } from '../../core/transaction-detail.js';

// Read-only provenance lines for the edit modal: which account a charge hit
// and what the bank actually called it. `detail` is undefined while loading,
// null when unavailable — editing never depends on it.
export function sourceLabel(d: TransactionDetail): string {
  if (d.source === 'plaid') return 'Plaid';
  if (d.source === 'manual') return 'Manual entry';
  if (d.source === 'csv') {
    const parts = [`CSV${d.importFile ? `: ${d.importFile}` : ''}`];
    if (d.importedAt) parts.push(`imported ${d.importedAt.slice(0, 10)}`);
    return parts.join(' · ');
  }
  return '';
}

export function TransactionDetailLines({ detail }: { detail: TransactionDetail | null | undefined }) {
  if (detail === undefined) return null;
  if (detail === null) return <Text dimColor>details unavailable</Text>;
  const acct = `${detail.accountName}${detail.accountMask ? ` ••${detail.accountMask}` : ''}${detail.institution ? ` · ${detail.institution}` : ''}`;
  const showMerchant = detail.merchantName && detail.merchantName !== detail.name;
  const src = sourceLabel(detail);
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate-end">Account          {acct}</Text>
      <Text dimColor wrap="truncate-end">Bank description  {detail.name}{showMerchant ? ` (${detail.merchantName})` : ''}</Text>
      {(src || detail.pending) ? (
        <Text dimColor wrap="truncate-end">Source           {src}{detail.pending ? `${src ? ' · ' : ''}Pending` : ''}</Text>
      ) : null}
    </Box>
  );
}
