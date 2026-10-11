/** How many skipped rows any import preview/done message lists before collapsing the rest into "and N more". One cap for every surface. */
export const SKIPPED_ROWS_SHOWN = 5;

export type SkippedPreview<T> = {
  /** Reason summary, e.g. "2 no matching account, 1 invalid date or amount"; empty when nothing was skipped. */
  summary: string;
  /** The first SKIPPED_ROWS_SHOWN skipped rows. */
  shown: T[];
  /** How many skipped rows are not in `shown`. */
  hiddenCount: number;
};

export function previewSkipped<T>(skipped: T[], summary: string): SkippedPreview<T> {
  return {
    summary,
    shown: skipped.slice(0, SKIPPED_ROWS_SHOWN),
    hiddenCount: Math.max(0, skipped.length - SKIPPED_ROWS_SHOWN),
  };
}
