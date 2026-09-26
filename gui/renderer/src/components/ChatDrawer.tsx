import React, { useEffect, useRef, useState } from 'react';
import { useNav } from '../hooks/useNav.js';
import { useFilter } from '../hooks/useFilter.js';
import type { Screen, TxFilter } from '../../../shared/nav.js';
import styles from './ChatDrawer.module.css';

type DisplayMsg = {
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
};

type Confirm = { id: number; description: string };

const MAX_DISPLAY = 200;

export function ChatDrawer() {
  const { navigate } = useNav();
  const { filter: sharedFilter, setFilter } = useFilter();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<DisplayMsg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const streamRef = useRef('');
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const filterRef = useRef({ sharedFilter, setFilter });
  filterRef.current = { sharedFilter, setFilter };

  function addMsg(msg: DisplayMsg) {
    setMsgs((prev) => {
      const next = [...prev, msg];
      return next.length > MAX_DISPLAY ? next.slice(-MAX_DISPLAY) : next;
    });
  }

  useEffect(() => {
    void window.__bridge.invoke('agent:provider').then((p) => setProvider(p as string | null));

    const offs = [
      window.__bridge.on('agent:text', (...args) => {
        streamRef.current += args[0] as string;
        setStreamText(streamRef.current);
      }),
      window.__bridge.on('agent:tool', (...args) => {
        addMsg({ role: 'tool', text: `⟳ ${args[1] as string}` });
      }),
      window.__bridge.on('agent:confirm', (...args) => {
        setConfirm({ id: args[0] as number, description: args[1] as string });
      }),
      window.__bridge.on('agent:navigate', (...args) => {
        const screen = args[0] as Screen;
        const filter = args[1] as Record<string, string> | undefined;
        // Filtering dimensions drive the sticky shared filter (replace those
        // dims); category/tag focus targets ride along as transient nav params.
        // Same translation as tui/Chat.tsx.
        if (screen === 'transactions' && (filter?.category || filter?.account || filter?.tag)) {
          filterRef.current.setFilter({
            ...filterRef.current.sharedFilter,
            ...(filter.category ? { categories: [filter.category] } : {}),
            ...(filter.account ? { accounts: [filter.account] } : {}),
            ...(filter.tag ? { tags: [{ name: filter.tag, mode: 'has' as const }] } : {}),
          });
        }
        const txFilter: TxFilter = {};
        if (filter?.from)   txFilter.from   = filter.from;
        if (filter?.to)     txFilter.to     = filter.to;
        if (filter?.search) txFilter.search = filter.search;
        if (filter?.range)  txFilter.range  = filter.range;
        if (filter?.anchor) txFilter.anchor = filter.anchor;
        if (filter?.canvasSpec) txFilter.canvasSpec = filter.canvasSpec;
        if (screen === 'trends' && filter?.category) txFilter.focusCategory = filter.category;
        if (screen === 'tags'   && filter?.tag)      txFilter.focusTag      = filter.tag;
        navigateRef.current(screen, Object.keys(txFilter).length ? txFilter : undefined);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  // Global backtick toggles the drawer (matching the TUI), unless typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inField = target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA';
      if (e.key === '`' && !inField) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [msgs, streamText, confirm]);

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    addMsg({ role: 'user', text });
    setStreaming(true);
    streamRef.current = '';
    try {
      await window.__bridge.invoke('agent:run', text);
      if (streamRef.current.trim()) addMsg({ role: 'assistant', text: streamRef.current });
    } catch (e) {
      addMsg({ role: 'error', text: `Error: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      streamRef.current = '';
      setStreamText('');
      setStreaming(false);
      setConfirm(null);
    }
  }

  function answerConfirm(yes: boolean) {
    if (!confirm) return;
    addMsg({ role: 'tool', text: yes ? `✓ ${confirm.description}` : '✗ Cancelled' });
    void window.__bridge.invoke('agent:respond-confirm', confirm.id, yes);
    setConfirm(null);
  }

  if (!open) {
    return (
      <button className={styles.collapsed} onClick={() => setOpen(true)} title="Toggle with `">
        <span className={styles.dot}>●</span> agent <span className={styles.keyHint}>[`]</span>{' '}
        {provider ? (
          <span className="dim">ask anything about your finances ({provider})</span>
        ) : (
          <span className="warn">no API key set</span>
        )}
        {streaming && <span className={styles.thinking}> ⟳</span>}
      </button>
    );
  }

  return (
    <div className={styles.drawer}>
      <div className={styles.header}>
        <span>
          <span className={styles.dot}>●</span> agent {provider && <span className="dim">({provider})</span>}
        </span>
        <span className={styles.headerBtns}>
          {msgs.length > 0 && (
            <button
              className={styles.headerBtn}
              onClick={() => {
                void window.__bridge.invoke('agent:reset');
                setMsgs([]);
              }}
            >
              clear
            </button>
          )}
          <button className={styles.headerBtn} onClick={() => setOpen(false)}>
            ▾ minimize
          </button>
        </span>
      </div>

      <div className={styles.transcript} ref={scrollRef}>
        {msgs.length === 0 && !streaming && (
          <p className="dim">
            {provider
              ? 'Ask anything about your finances — the agent can query, edit, and build interactive models.'
              : 'No API key — add ANTHROPIC_API_KEY or OPENAI_API_KEY to ~/.fungible/.env'}
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={styles[m.role]}>
            {m.role === 'user' && <span className={styles.who}>You</span>}
            {m.role === 'assistant' && <span className={styles.whoAgent}>Agent</span>}
            <span className={styles.msgText}>{m.text}</span>
          </div>
        ))}
        {streamText && (
          <div className={styles.assistant}>
            <span className={styles.whoAgent}>Agent</span>
            <span className={styles.msgText}>
              {streamText}
              <span className={styles.cursor}>▊</span>
            </span>
          </div>
        )}
        {streaming && !streamText && !confirm && <p className={`accent ${styles.thinkingLine}`}>⟳ thinking…</p>}
        {confirm && (
          <div className={styles.confirm}>
            <span className="warn">⚠ {confirm.description}</span>
            <span className={styles.confirmBtns}>
              <button className={styles.confirmYes} onClick={() => answerConfirm(true)}>
                Confirm
              </button>
              <button className={styles.confirmNo} onClick={() => answerConfirm(false)}>
                Cancel
              </button>
            </span>
          </div>
        )}
      </div>

      <div className={styles.inputRow}>
        <span className="accent">›</span>
        <input
          ref={inputRef}
          className={styles.input}
          value={input}
          disabled={!provider}
          placeholder={provider ? 'Ask the agent…' : 'No API key configured'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send();
            if (e.key === 'Escape') {
              inputRef.current?.blur();
              setOpen(false);
            }
          }}
        />
      </div>
    </div>
  );
}
