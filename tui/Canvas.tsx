import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Screen } from './App.js';
import { handleNavKey } from './nav.js';
import { Divider } from './fmt.js';
import { C_POSITIVE, C_NEGATIVE, C_NEUTRAL, C_ACCENT, C_WARNING } from './ui.js';
import { PageHeader, SectionHeader, DialRow, TextInput } from './components/index.js';
import { generateCanvas, evalExpr, fmtValue, fmtDialValue, type CanvasSpec, type DialDef } from '../core/canvas-agent.js';
import { useSetTyping } from './TypingContext.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const LABEL_W = 18;
const VALUE_W = 12;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function outputColor(color: string | undefined): string | undefined {
  switch (color) {
    case 'positive': return C_POSITIVE;
    case 'negative': return C_NEGATIVE;
    case 'accent':   return C_ACCENT;
    default:         return C_NEUTRAL;
  }
}

function dialStep(dial: DialDef, dir: 1 | -1, val: number): number {
  const next = parseFloat((val + dir * dial.step).toFixed(10));
  if (dial.min !== undefined && next < dial.min) return dial.min;
  if (dial.max !== undefined && next > dial.max) return dial.max;
  return next;
}

// ─── CanvasView — testable rendering of a CanvasSpec ─────────────────────────

export function CanvasView({ spec, isActive }: { spec: CanvasSpec; isActive?: boolean }) {
  const dials = spec.elements.flatMap((el) => el.type === 'dial' ? [el.dial] : []);
  const [dialValues, setDialValues] = useState<Record<string, number>>(() => {
    const d: Record<string, number> = {};
    dials.forEach((dl) => { d[dl.key] = dl.default; });
    return d;
  });
  const [dialIdx, setDialIdx] = useState(0);

  const currentKey = dials[dialIdx]?.key;

  useInput((_input, key) => {
    if (key.upArrow)   { setDialIdx((i) => (i - 1 + dials.length) % dials.length); return; }
    if (key.downArrow) { setDialIdx((i) => (i + 1) % dials.length); return; }
    if (key.rightArrow && currentKey) {
      setDialValues((v) => ({ ...v, [currentKey]: dialStep(dials[dialIdx], 1,  v[currentKey] ?? dials[dialIdx].default) }));
    }
    if (key.leftArrow && currentKey) {
      setDialValues((v) => ({ ...v, [currentKey]: dialStep(dials[dialIdx], -1, v[currentKey] ?? dials[dialIdx].default) }));
    }
    if (_input === 'r' && currentKey) {
      setDialValues((v) => ({ ...v, [currentKey]: dials[dialIdx].default }));
    }
  }, { isActive: isActive !== false });

  return (
    <Box flexDirection="column">
      <Text bold>{spec.title}</Text>

      {spec.elements.map((el, i) => {
        if (el.type === 'section') {
          return <Box key={i} marginTop={1}><SectionHeader>{el.label}</SectionHeader></Box>;
        }

        if (el.type === 'text') {
          return <Box key={i}><Text dimColor>{el.content}</Text></Box>;
        }

        if (el.type === 'dial') {
          const d = el.dial;
          const val = dialValues[d.key] ?? d.default;
          const isSelected = dials[dialIdx]?.key === d.key;
          const atDefault = val === d.default;
          return (
            <DialRow
              key={i}
              label={d.label}
              value={fmtDialValue(val, d.format)}
              selected={isSelected}
              labelWidth={LABEL_W}
              valueWidth={VALUE_W}
              description={isSelected
                ? `← → ±${fmtDialValue(d.step, d.format)}${!atDefault ? '  ·  [r] reset' : ''}`
                : `${d.hint}${!atDefault ? ' (modified)' : ''}`}
            />
          );
        }

        if (el.type === 'output') {
          const out = el.output;
          const val = evalExpr(out.expr, dialValues);
          return (
            <Box key={i} gap={3}>
              <Text dimColor>{out.label.padEnd(LABEL_W)}</Text>
              <Text bold color={outputColor(out.color)}>{fmtValue(val, out.format).padStart(VALUE_W)}</Text>
            </Box>
          );
        }

        return null;
      })}
    </Box>
  );
}

// ─── Canvas screen ────────────────────────────────────────────────────────────

type Mode = 'prompt' | 'dials';

export function Canvas({ onNavigate, isActive, showHints }: {
  onNavigate: (s: Screen) => void;
  isActive?: boolean;
  showHints: boolean;
}) {
  const [mode,   setMode]   = useState<Mode>('prompt');
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState('');
  const [spec,   setSpec]   = useState<CanvasSpec | null>(null);
  const [error,  setError]  = useState('');

  const setTyping = useSetTyping();

  const runGenerate = useCallback(async (p: string) => {
    setError('');
    setSpec(null);
    setTyping(false);
    setMode('dials');
    try {
      const s = await generateCanvas(p, setStatus);
      setSpec(s);
      setStatus('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('');
      setMode('prompt');
    }
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      if (mode === 'dials') { setMode('prompt'); setTyping(true); return; }
      onNavigate('dashboard');
      return;
    }
    handleNavKey(input, 'canvas', onNavigate);

    if (mode === 'prompt') {
      setTyping(true);
      if (key.return && prompt.trim()) { void runGenerate(prompt.trim()); return; }
      if (key.backspace || key.delete) { setPrompt((p) => p.slice(0, -1)); return; }
      if (!key.ctrl && !key.meta && input) setPrompt((p) => p + input);
      return;
    }

    if (input === 'p' || input === '/') { setMode('prompt'); setTyping(true); }
  }, { isActive: isActive !== false });

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <PageHeader current="canvas" showHints={showHints} />

      <Box marginTop={1}><Text bold>Canvas</Text></Box>
      {showHints && mode === 'dials' && spec && (
        <Text dimColor>↑↓ select  ·  ← → adjust  ·  [r] reset  ·  [p] new prompt</Text>
      )}

      {/* ── Prompt bar ─────────────────────────────────────────────────── */}
      <Box marginTop={1} gap={1}>
        <Text color={C_ACCENT}>›</Text>
        {mode === 'prompt'
          ? <TextInput value={prompt} placeholder="what do you want to calculate?" />
          : <Text dimColor>{prompt}</Text>
        }
        {mode === 'prompt' && showHints && prompt.trim() && (
          <Text dimColor>  Enter to generate</Text>
        )}
      </Box>

      <Box marginTop={1}><Divider /></Box>

      {error && <Box marginTop={1}><Text color={C_WARNING}>{error}</Text></Box>}

      {!spec && !error && status && <Box marginTop={1}><Text dimColor>{status}</Text></Box>}

      {!spec && !error && !status && (
        <Box marginTop={1}><Text dimColor>Ask a financial question and press Enter.</Text></Box>
      )}

      {spec && <Box marginTop={1}><CanvasView spec={spec} isActive={mode === 'dials'} /></Box>}
    </Box>
  );
}
