// Shared verdict scale used across health/scorecard/etc. severity bands, so
// gui/tui can render one shared vocabulary instead of each inventing its own
// pos/warn/neg/dim class names.
export type SeverityLevel = 'good' | 'neutral' | 'caution' | 'bad';
