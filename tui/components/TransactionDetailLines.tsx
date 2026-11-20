import { Box, Text } from 'ink';
import type { TransactionDetail } from '../../core/transaction-detail.js';
import { fmtTransactionSource } from '../../core/fmt.js';

// Read-only provenance lines for the edit modal: which account a charge hit
// and what the bank actually called it. `detail` is undefined while loading,
// null when unavailable — editing never depends on it.
export function TransactionDetailLines({ detail }: { detail: TransactionDetail | null | undefined }) {
  if (detail === undefined) return null;
  if (detail === null) return <Text dimColor>details unavailable</Text>;
  const acct = `${detail.accountName}${detail.accountMask ? ` ••${detail.accountMask}` : ''}${detail.institution ? ` · ${detail.institution}` : ''}`;
  const showMerchant = detail.merchantName && detail.merchantName !== detail.name;
  const src = fmtTransactionSource(detail);
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate-end">Account          {acct}</Text>
      <Box>
        <Box width={17} flexShrink={0}><Text dimColor>Bank description</Text></Box>
        <Box flexGrow={1} flexShrink={1}><Text dimColor wrap="wrap">{detail.name}{showMerchant ? ` (${detail.merchantName})` : ''}</Text></Box>
      </Box>
      {(src || detail.pending) ? (
        <Text dimColor wrap="truncate-end">Source           {src}{detail.pending ? `${src ? ' · ' : ''}Pending` : ''}</Text>
      ) : null}
    </Box>
  );
}
