import type { SeverityLevel } from '../../../../core/severity.js';

// SeverityLevel -> this app's existing pos/warn/neg/(neutral) class names.
// Shared by Dashboard (drift vs. typical month) and Health (savings
// rate/runway/debt-payoff bands) so the two screens can't drift apart on
// what each verdict looks like.
export function severityToClass(level: SeverityLevel): string {
  switch (level) {
    case 'good': return 'pos';
    case 'caution': return 'warn';
    case 'bad': return 'neg';
    case 'neutral': return '';
  }
}
