import React, { useState, useRef, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { runAgentTurn } from '../core/agent.js';
import type { Message } from '../core/llm-provider.js';
import { detectProvider, getProviderModel } from '../core/llm-provider.js';
import { truncate } from './fmt.js';
import { CURSOR, C_POSITIVE, C_NEGATIVE, C_WARNING, C_ACCENT, C_DIM } from './ui.js';
import type { Screen, TxFilter } from './App.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type DisplayMsg = {
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
};

type ConfirmState = {
  description: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CHAT_HISTORY_LINES = 5; // lines of conversation shown above input

function providerLabel(): string {
  try {
    const p = detectProvider();
    const m = getProviderModel(p);
    return `${p}/${m.split('-').slice(0, 3).join('-')}`;
  } catch {
    return 'no key set';
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function Chat({
  isActive,
  onActivate,
  onDeactivate,
  onNavigate,
}: {
  isActive: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
  onNavigate: (s: Screen, f?: TxFilter) => void;
}) {
  const [displayMsgs, setDisplayMsgs] = useState<DisplayMsg[]>([]);
  const [input, setInput]             = useState('');
  const [isStreaming, setIsStreaming]  = useState(false);
  const [streamText, setStreamText]   = useState('');
  const [confirm, setConfirm]         = useState<ConfirmState | null>(null);

  // Refs that don't need to trigger re-renders
  const historyRef        = useRef<Message[]>([]);
  const streamTextRef     = useRef('');
  const confirmResolveRef = useRef<((yes: boolean) => void) | null>(null);

  const MAX_DISPLAY = 200;
  const addDisplay = useCallback((msg: DisplayMsg) => {
    setDisplayMsgs((prev) => {
      const next = [...prev, msg];
      return next.length > MAX_DISPLAY ? next.slice(-MAX_DISPLAY) : next;
    });
  }, []);

  // ── Send a message ─────────────────────────────────────────────────────────

  async function send(text: string) {
    if (!text.trim() || isStreaming) return;
    setInput('');
    addDisplay({ role: 'user', text: text.trim() });
    setIsStreaming(true);
    streamTextRef.current = '';
    // Snapshot history length so we can roll back on error
    const historyLenBefore = historyRef.current.length;

    try {
      await runAgentTurn(text.trim(), historyRef.current, {
        onText: (delta) => {
          streamTextRef.current += delta;
          setStreamText(streamTextRef.current);
        },
        onToolCall: (_name, desc) => {
          addDisplay({ role: 'tool', text: `⟳ ${desc}` });
        },
        onConfirm: (desc) => new Promise<boolean>((resolve) => {
          setConfirm({ description: desc });
          confirmResolveRef.current = (yes) => {
            setConfirm(null);
            confirmResolveRef.current = null;
            addDisplay({ role: 'tool', text: yes ? `✓ ${desc}` : `✗ Cancelled` });
            resolve(yes);
          };
        }),
        onNavigate: (screen, filter) => {
          const txFilter: TxFilter = {};
          if (filter?.category)    txFilter.category    = filter.category;
          if (filter?.from)        txFilter.from        = filter.from;
          if (filter?.to)          txFilter.to          = filter.to;
          if (filter?.tag)         txFilter.tag         = filter.tag;
          if (filter?.account)     txFilter.account     = filter.account;
          if (filter?.accountName) txFilter.accountName = filter.accountName;
          onNavigate(screen as Screen, Object.keys(txFilter).length ? txFilter : undefined);
        },
      });

      // Finalise streaming text as an assistant message
      const final = streamTextRef.current;
      if (final.trim()) addDisplay({ role: 'assistant', text: final });

    } catch (e) {
      // Roll back any partial history mutations from this turn
      historyRef.current.splice(historyLenBefore);
      addDisplay({ role: 'error', text: `Error: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setStreamText('');
      streamTextRef.current = '';
      setIsStreaming(false);
    }
  }

  // ── Input handling ─────────────────────────────────────────────────────────

  useInput((char, key) => {

    // Confirmation mode
    if (confirm) {
      if (char === 'y' || char === 'Y') { confirmResolveRef.current?.(true); return; }
      if (char === 'n' || char === 'N' || key.escape) { confirmResolveRef.current?.(false); return; }
      return;
    }

    // Activate on backtick when not active
    if (!isActive) {
      if (char === '`') { onActivate(); return; }
      return;
    }

    // Deactivate on Escape
    if (key.escape) {
      if (input === '') { onDeactivate(); }
      else { setInput(''); }
      return;
    }

    if (key.return) { send(input); return; }

    if (key.backspace || key.delete) {
      setInput((s) => s.slice(0, -1));
      return;
    }

    // Printable characters
    if (char && !key.ctrl && !key.meta) {
      setInput((s) => s + char);
    }

  }, { isActive: true }); // always listen — we gate internally

  // ── Render ─────────────────────────────────────────────────────────────────

  const label = providerLabel();
  const colW  = 80; // approximate terminal width for separator

  // Visible history: last N display messages
  const visible = displayMsgs.slice(-CHAT_HISTORY_LINES);

  if (!isActive && !displayMsgs.length && !isStreaming) {
    const noKey = label === 'no key set';
    return (
      <Box borderStyle="single" borderColor={C_DIM} paddingX={1}>
        <Text dimColor>agent  </Text>
        {noKey
          ? <Text dimColor color={C_WARNING}>no API key — add ANTHROPIC_API_KEY or OPENAI_API_KEY to .env</Text>
          : <Text dimColor>[ ` ] ask anything about your finances  <Text>({label})</Text></Text>
        }
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={isActive ? C_ACCENT : C_DIM} paddingX={1}>

      {/* Header */}
      <Box justifyContent="space-between">
        <Text color={isActive ? C_ACCENT : undefined} dimColor={!isActive}>
          agent ({label})
        </Text>
        {isActive
          ? <Text dimColor>[Esc] back to app</Text>
          : <Text dimColor>[ ` ] focus</Text>
        }
      </Box>

      {/* Message history */}
      {visible.map((msg, i) => {
        if (msg.role === 'user') {
          return (
            <Box key={i} gap={1}>
              <Text color={C_ACCENT}>You</Text>
              <Text>{truncate(msg.text, colW - 6)}</Text>
            </Box>
          );
        }
        if (msg.role === 'tool') {
          return (
            <Box key={i}>
              <Text dimColor>{truncate(msg.text, colW - 2)}</Text>
            </Box>
          );
        }
        if (msg.role === 'error') {
          return (
            <Box key={i}>
              <Text color={C_NEGATIVE}>{truncate(msg.text, colW - 2)}</Text>
            </Box>
          );
        }
        // assistant
        return (
          <Box key={i} gap={1}>
            <Text color={C_POSITIVE}>Agent</Text>
            <Text wrap="wrap">{msg.text}</Text>
          </Box>
        );
      })}

      {/* Streaming text */}
      {streamText ? (
        <Box gap={1}>
          <Text color={C_POSITIVE}>Agent</Text>
          <Text wrap="wrap">{streamText}</Text>
          <Text color={C_ACCENT} dimColor>{CURSOR}</Text>
        </Box>
      ) : isStreaming && !confirm ? (
        <Box>
          <Text dimColor color={C_ACCENT}>⟳ thinking…</Text>
        </Box>
      ) : null}

      {/* Confirmation prompt */}
      {confirm && (
        <Box flexDirection="column">
          <Box>
            <Text color={C_WARNING}>⚠ </Text>
            <Text>{confirm.description}</Text>
          </Box>
          <Box gap={3}>
            <Text color={C_POSITIVE}>[y] confirm</Text>
            <Text color={C_NEGATIVE}>[n] cancel</Text>
          </Box>
        </Box>
      )}

      {/* Input line */}
      {isActive && !confirm && (
        <Box>
          <Text color={C_ACCENT}>› </Text>
          <Text>{input}</Text>
          {!isStreaming && <Text color={C_ACCENT}>{CURSOR}</Text>}
        </Box>
      )}
    </Box>
  );
}
