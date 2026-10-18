'use client';

import {useEffect, useState} from 'react';

export function TodayView() {
  const [body, setBody] = useState<{date?: string; summary?: string | null; topOutcomes?: string[]; blocks?: {label: string; role: string | null; state: string}[]} | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      void fetch('/api/v1/today', {cache: 'no-store'})
        .then(async (res) => {
          const json = await res.json().catch(() => null);
          if (!res.ok) return setError(json?.error?.message ?? 'Could not load today.');
          setBody(json);
        })
        .catch(() => setError('Could not load today.'));
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  return (
    <section className="panel">
      <h2>Today</h2>
      {error && <p className="warning">{error}</p>}
      {!body && !error && <p className="muted">Loading…</p>}
      {body && (
        <>
          <p>{body.summary ?? 'No briefing stored for today yet. Generate one from the home briefing.'}</p>
          <ul className="plain">
            {(body.topOutcomes ?? []).map((title) => (
              <li key={title}>{title}</li>
            ))}
          </ul>
          <ul className="plain">
            {(body.blocks ?? []).map((block) => (
              <li key={block.label}>
                {block.label} · {block.role ?? 'unmapped'} · {block.state}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function ProjectsView() {
  const [tasks, setTasks] = useState<{id: string; title: string; notionStatus: string; canonical: string; url: string}[]>([]);
  const [note, setNote] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      void fetch('/api/projects', {cache: 'no-store'})
        .then(async (res) => {
          const json = await res.json().catch(() => null);
          if (!res.ok) return setNote(json?.error?.message ?? 'Could not load projects.');
          setTasks(json.tasks ?? []);
          if (json.health?.state !== 'connected') setNote(json.health?.message ?? 'Notion is not connected.');
        })
        .catch(() => setNote('Could not load projects.'));
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  return (
    <section className="panel">
      <h2>Projects and tasks</h2>
      {note && <p className="muted">{note}</p>}
      <ul className="plain">
        {tasks.map((task) => (
          <li key={task.id}>
            <a href={task.url}>{task.title}</a> · {task.notionStatus} · {task.canonical}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AgentsView() {
  const [agents, setAgents] = useState<{id: string; title: string; mission: string; nextRun: string; lastRun: {status: string} | null}[]>([]);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      void fetch('/api/agents', {cache: 'no-store'})
        .then(async (res) => {
          const json = await res.json().catch(() => null);
          if (!res.ok) return setMessage(json?.error?.message ?? 'Could not load agents.');
          setAgents(json.agents ?? []);
        })
        .catch(() => setMessage('Could not load agents.'));
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  async function run(agentId: string) {
    const res = await fetch('/api/agents', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({agentId})});
    const json = await res.json().catch(() => null);
    setMessage(res.ok ? json.result?.summary ?? json.outcome : json?.error?.message ?? 'Run failed.');
  }
  return (
    <section className="panel">
      <h2>Agent workspace</h2>
      {message && <p className="notice">{message}</p>}
      <ul className="plain">
        {agents.map((agent) => (
          <li key={agent.id} className="task">
            <div>
              <strong>{agent.title}</strong>
              <small>{agent.mission}</small>
              <small>Next: {agent.nextRun}. Last: {agent.lastRun?.status ?? 'none'}.</small>
            </div>
            {agent.id !== 'gmail.morning' && (
              <button type="button" onClick={() => run(agent.id)}>Run</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ApprovalsView() {
  const [rows, setRows] = useState<{id: string; action: string; risk: string; status: string; evidence: string | null}[]>([]);
  const [message, setMessage] = useState('');
  async function load() {
    const res = await fetch('/api/approvals', {cache: 'no-store'});
    const json = await res.json().catch(() => null);
    if (!res.ok) setMessage(json?.error?.message ?? 'Could not load approvals.');
    else setRows(json.approvals ?? []);
  }
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, []);
  async function decide(id: string, status: 'approved' | 'rejected') {
    const res = await fetch('/api/approvals', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id, status})});
    const json = await res.json().catch(() => null);
    setMessage(res.ok ? `Recorded ${json.outcome}. External sends stay off.` : json?.error?.message ?? 'Could not decide.');
    await load();
  }
  return (
    <section className="panel">
      <h2>Approvals</h2>
      {message && <p className="notice">{message}</p>}
      {!rows.length && <p className="muted">Nothing is waiting.</p>}
      <ul className="plain">
        {rows.map((row) => (
          <li key={row.id} className="task">
            <div>
              <strong>{row.action}</strong>
              <small>{row.risk} · {row.status}{row.evidence ? ` · ${row.evidence}` : ''}</small>
            </div>
            {row.status === 'pending' && (
              <div className="row-actions">
                <button type="button" onClick={() => decide(row.id, 'approved')}>Approve</button>
                <button type="button" className="ghost" onClick={() => decide(row.id, 'rejected')}>Reject</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CalendarView() {
  const [body, setBody] = useState<{health?: {message: string}; events?: {id: string; title: string}[]; conflicts?: {reason: string}[]; prep?: {title: string; write: boolean}[]} | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      void fetch('/api/calendar', {cache: 'no-store'}).then(async (res) => {
        const json = await res.json().catch(() => null);
        if (!res.ok) return setBody({health: {message: json?.error?.message ?? 'Could not load calendar.'}});
        setBody(json);
      });
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  return (
    <section className="panel">
      <h2>Calendar and commitments</h2>
      <p className="muted">{body?.health?.message ?? 'Loading…'}</p>
      <ul className="plain">
        {(body?.conflicts ?? []).map((item) => (
          <li key={item.reason}>{item.reason}</li>
        ))}
        {(body?.prep ?? []).map((item) => (
          <li key={item.title}>{item.title}{item.write ? '' : ' · proposal only'}</li>
        ))}
      </ul>
    </section>
  );
}

export function MemoryView() {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<{id: string; partition: string; body: string}[]>([]);
  const [message, setMessage] = useState('');
  async function load() {
    const res = await fetch('/api/memory', {cache: 'no-store'});
    const json = await res.json().catch(() => null);
    if (res.ok) setRows(json.memories ?? []);
    else setMessage(json?.error?.message ?? 'Could not load notes.');
  }
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, []);
  async function add() {
    const res = await fetch('/api/memory', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({partition: 'reflection', body: text, provenance: 'journal'})});
    const json = await res.json().catch(() => null);
    if (!res.ok) return setMessage(json?.error?.message ?? 'Could not save.');
    setText('');
    setMessage('Saved in the private reflection partition.');
    await load();
  }
  async function remove(id: string) {
    await fetch('/api/memory', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({op: 'delete', id})});
    await load();
  }
  return (
    <section className="panel">
      <h2>Memory and reflections</h2>
      {message && <p className="notice">{message}</p>}
      <label className="muted" htmlFor="memory-note">Private note</label>
      <textarea id="memory-note" className="import-paste" value={text} onChange={(e) => setText(e.target.value)} />
      <button type="button" onClick={add} disabled={!text.trim()}>Save reflection</button>
      <ul className="plain">
        {rows.map((row) => (
          <li key={row.id}>
            {row.partition}: {row.body} <button type="button" className="ghost" onClick={() => remove(row.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
