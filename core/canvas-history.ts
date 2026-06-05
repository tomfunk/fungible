import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './paths.js';
import type { CanvasSpec } from './canvas-agent.js';

export const CANVAS_HISTORY_PATH = join(DATA_DIR, 'canvas-history.json');
export const CANVAS_SPEC_PATH    = join(DATA_DIR, 'canvas-spec.json');

export type CanvasHistoryEntry = {
  id: string;
  title: string;
  prompt: string;
  spec: CanvasSpec;
  createdAt: string;
  updatedAt?: string;
  versions?: number;
};

export function loadHistory(): CanvasHistoryEntry[] {
  try {
    return JSON.parse(readFileSync(CANVAS_HISTORY_PATH, 'utf-8')) as CanvasHistoryEntry[];
  } catch {
    return [];
  }
}

export function appendHistory(entry: Omit<CanvasHistoryEntry, 'id' | 'createdAt'>): CanvasHistoryEntry {
  const history = loadHistory();
  const existing = history.find((e) => e.title === entry.title);
  let saved: CanvasHistoryEntry;
  if (existing) {
    saved = {
      ...existing,
      spec: entry.spec,
      prompt: entry.prompt,
      updatedAt: new Date().toISOString(),
      versions: (existing.versions ?? 1) + 1,
    };
    const rest = history.filter((e) => e.id !== existing.id);
    writeFileSync(CANVAS_HISTORY_PATH, JSON.stringify([saved, ...rest], null, 2), 'utf-8');
  } else {
    saved = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(CANVAS_HISTORY_PATH, JSON.stringify([saved, ...history], null, 2), 'utf-8');
  }
  return saved;
}

export function searchHistory(query?: string): CanvasHistoryEntry[] {
  const history = loadHistory();
  if (!query) return history;
  const q = query.toLowerCase();
  return history.filter(
    (e) => e.title.toLowerCase().includes(q) || e.prompt.toLowerCase().includes(q),
  );
}

export function getHistoryEntry(id: string): CanvasHistoryEntry | undefined {
  return loadHistory().find((e) => e.id === id);
}

export function deleteHistoryEntry(id: string): boolean {
  const history = loadHistory();
  const next = history.filter((e) => e.id !== id);
  if (next.length === history.length) return false;
  writeFileSync(CANVAS_HISTORY_PATH, JSON.stringify(next, null, 2), 'utf-8');
  return true;
}

export function buildPriorCanvasesSection(prompt: string): string {
  const priorCanvases = searchHistory(prompt).slice(0, 3);
  if (!priorCanvases.length) return '';
  const entries = priorCanvases.map(
    (e) => `### ${e.title}\nprompt: ${e.prompt}\n\`\`\`json\n${JSON.stringify(e.spec, null, 2)}\n\`\`\``,
  ).join('\n\n');
  return `## Prior canvases on similar topics\n\nBefore generating from scratch, check if any of these existing canvases covers the same type of problem. If so, build on it — extend or adjust its dials/outputs to address the new question, and keep the same title so it updates in place rather than creating a duplicate.\n\n${entries}`;
}
