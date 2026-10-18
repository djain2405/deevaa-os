'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import type {IntakeResult, ItemResult} from '@/lib/intake';

type ChatMessage = {id: string; role: 'user' | 'assistant'; content: string; createdAt: string; result: IntakeResult | null};

const ACTION_LABEL: Record<ItemResult['action'], string> = {
  created: 'Created',
  updated: 'Updated',
  unchanged: 'No change',
  proposed: 'Not applied',
  failed: 'Failed',
  ambiguous: 'Needs you',
  skipped: 'Skipped',
  undone: 'Undone'
};
const ACTION_BADGE: Record<ItemResult['action'], string> = {
  created: 'connected',
  updated: 'connected',
  unchanged: 'not_connected',
  proposed: 'pending',
  failed: 'error',
  ambiguous: 'pending',
  skipped: 'not_connected',
  undone: 'not_connected'
};
const NOTE_LABEL: Record<string, string> = {
  goal: 'Goal',
  preference: 'Preference',
  personal_context: 'Personal context',
  reflection: 'Reflection',
  capacity: 'Capacity',
  project: 'Project',
  constraint: 'Date constraint'
};

const stamp = (iso: string) => new Date(iso).toLocaleString('en-US', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles'});

function ItemRow({item}: {item: ItemResult}) {
  return (
    <li className="intake-item">
      <span className={`badge badge-${ACTION_BADGE[item.action]}`}>{ACTION_LABEL[item.action]}</span>
      <div>
        <strong>
          {item.url ? (
            <a href={item.url} target="_blank" rel="noreferrer">
              {item.title}
              <span className="visually-hidden"> (opens Notion in a new tab)</span>
            </a>
          ) : (
            item.title
          )}
        </strong>
        {(item.changes ?? []).length > 0 && <small>{(item.changes ?? []).join(' · ')}</small>}
        {item.detail && <small>{item.detail}</small>}
        {item.candidates && (
          <small>
            Candidates:{' '}
            {item.candidates.map((c, i) => (
              <span key={c.url}>
                {i > 0 && ', '}
                <a href={c.url} target="_blank" rel="noreferrer">{c.title}</a>
              </span>
            ))}
          </small>
        )}
        {item.evidence && <small className="muted">You said: “{item.evidence}”</small>}
        {item.assumption && <small className="muted">Assumption: {item.assumption}</small>}
      </div>
    </li>
  );
}

export function ChatPanel({writes, onChanged}: {writes?: 'granted' | 'off' | null; onChanged?: () => void}) {
  const [writeState, setWriteState] = useState<'granted' | 'off' | null>(writes ?? null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const load = useCallback(async () => {
    const res = await fetch('/api/chat', {cache: 'no-store'});
    if (res.status === 401) return void (window.location.href = '/login');
    const body = await res.json().catch(() => null);
    if (!res.ok) return setError(body?.error?.message ?? 'Could not load the conversation.');
    setMessages(Array.isArray(body.messages) ? body.messages : []);
    if (body.notionWrites === 'granted' || body.notionWrites === 'off') setWriteState(body.notionWrites);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({block: 'nearest'});
  }, [messages.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setError('');
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID()},
        body: JSON.stringify({message})
      });
      if (res.status === 401) return void (window.location.href = '/login');
      const body = await res.json().catch(() => null);
      if (!res.ok) return setError(body?.error?.message ?? 'The message could not be processed.');
      setText('');
      await load();
      if (body.briefing && body.briefing !== 'skipped') onChanged?.();
    } finally {
      setSending(false);
    }
  }

  async function act(kind: 'apply' | 'undo', messageId: string) {
    if (kind === 'undo' && !window.confirm('Undo Deevaa’s changes from this message? Created tasks move to Notion’s trash; updated tasks get their previous values back.')) return;
    setBusyId(messageId);
    setError('');
    try {
      const res = await fetch(`/api/chat/${kind}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({messageId})});
      const body = await res.json().catch(() => null);
      if (!res.ok) setError(body?.error?.message ?? 'That did not work.');
      await load();
      onChanged?.();
    } finally {
      setBusyId(null);
    }
  }

  async function clear() {
    if (!window.confirm('Delete the chat history and any unreviewed notes? Notion tasks are not affected.')) return;
    const res = await fetch('/api/chat', {method: 'DELETE'});
    if (!res.ok) setError('Could not delete the history.');
    await load();
  }

  return (
    <section className="panel chat" aria-labelledby="chat-title">
      <div className="panel-head">
        <h2 id="chat-title">Tell Deevaa what’s going on</h2>
        {messages.length > 0 && (
          <button type="button" className="ghost small-btn" onClick={clear}>
            Clear history
          </button>
        )}
      </div>
      <p className="muted">
        Write naturally. Deevaa pulls out tasks, deadlines and status changes, checks Notion for matching tasks, and{' '}
        {writeState === 'granted' ? 'updates Deevaa Tasks, then shows exactly what changed.' : 'shows the changes it would make. Turn on Notion updates in Connections to apply them.'}
      </p>
      <ol className="chat-log" ref={listRef} aria-live="polite">
        {messages.map((m) =>
          m.role === 'user' ? (
            <li key={m.id} className="msg msg-user">
              <p>{m.content}</p>
              <small className="muted">{stamp(m.createdAt)}</small>
            </li>
          ) : (
            <li key={m.id} className="msg msg-deevaa">
              <p>{m.content}</p>
              {m.result && (m.result.items ?? []).length > 0 && <ul className="plain">{(m.result.items ?? []).map((it, i) => <ItemRow key={it.opId ?? i} item={it} />)}</ul>}
              {m.result && (m.result.notes ?? []).length > 0 && (
                <ul className="plain notes">
                  {(m.result.notes ?? []).map((n) => (
                    <li key={n.id}>
                      <span className="badge badge-pending">{NOTE_LABEL[n.kind] ?? n.kind}</span> {n.text}
                    </li>
                  ))}
                </ul>
              )}
              {(m.result?.clarifications ?? []).map((c, i) => (
                <p key={i} className="clarify">{c}</p>
              ))}
              {m.result?.extractorNote && <small className="muted">{m.result.extractorNote}</small>}
              {m.result && (
                <div className="row-actions">
                  {writeState === 'granted' && m.result.items.some((i) => i.action === 'proposed' || (i.action === 'failed' && i.opId)) && (
                    <button type="button" className="small-btn" disabled={busyId === m.result.messageId} onClick={() => act('apply', m.result!.messageId)}>
                      Apply to Notion
                    </button>
                  )}
                  {writeState === 'granted' && m.result.items.some((i) => (i.action === 'created' || i.action === 'updated') && i.opId) && (
                    <button type="button" className="ghost small-btn" disabled={busyId === m.result.messageId} onClick={() => act('undo', m.result!.messageId)}>
                      Undo these changes
                    </button>
                  )}
                </div>
              )}
            </li>
          )
        )}
      </ol>
      <form className="chat-form" onSubmit={send}>
        <label htmlFor="chat-input" className="visually-hidden">
          Message to Deevaa
        </label>
        <textarea
          id="chat-input"
          value={text}
          maxLength={4000}
          rows={3}
          placeholder="e.g. I need to renew my passport by November 30. I already sent the article draft to my editor."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(e);
          }}
        />
        <button type="submit" className="cta" disabled={sending || !text.trim()} aria-busy={sending}>
          {sending ? 'Working…' : 'Send'}
        </button>
      </form>
      {error && <p className="warning" role="alert">{error}</p>}
    </section>
  );
}
