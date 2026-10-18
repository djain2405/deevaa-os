'use client';

import {useEffect, useState} from 'react';

export function TodayView() {
  const [body, setBody] = useState<{
    date?: string;
    summary?: string | null;
    topOutcomes?: string[];
    blocks?: {label: string; role: string | null; state: string; nextAction?: string | null; emptyDetail?: string | null}[];
  } | null>(null);
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
                {block.nextAction ? ` · ${block.nextAction}` : ''}
                {block.emptyDetail && block.state === 'omitted' ? ` · ${block.emptyDetail}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

type ProjectTask = {
  id: string;
  title: string;
  notionStatus: string;
  canonical: 'inbox' | 'next' | 'scheduled' | 'waiting' | 'someday' | 'done' | 'canceled';
  due: string | null;
  project: string | null;
  url: string;
  nextAction: string | null;
};

type ProjectFilter = 'open' | 'waiting' | 'scheduled' | 'someday' | 'done' | 'all';

const PROJECT_FILTERS: {id: ProjectFilter; label: string}[] = [
  {id: 'open', label: 'Open'},
  {id: 'waiting', label: 'Waiting'},
  {id: 'scheduled', label: 'Scheduled'},
  {id: 'someday', label: 'Someday'},
  {id: 'done', label: 'Done'},
  {id: 'all', label: 'All'}
];

const CANONICAL_LABEL: Record<ProjectTask['canonical'], string> = {
  inbox: 'Inbox',
  next: 'Ready',
  scheduled: 'Scheduled',
  waiting: 'Waiting',
  someday: 'Someday',
  done: 'Done',
  canceled: 'Canceled'
};

const CANONICAL_BADGE: Record<ProjectTask['canonical'], string> = {
  inbox: 'pending',
  next: 'connected',
  scheduled: 'pending',
  waiting: 'pending',
  someday: 'not_connected',
  done: 'connected',
  canceled: 'not_connected'
};

function projectFilterMatch(task: ProjectTask, filter: ProjectFilter) {
  switch (filter) {
    case 'open':
      return task.canonical !== 'done' && task.canonical !== 'canceled';
    case 'waiting':
      return task.canonical === 'waiting';
    case 'scheduled':
      return task.canonical === 'scheduled';
    case 'someday':
      return task.canonical === 'someday';
    case 'done':
      return task.canonical === 'done' || task.canonical === 'canceled';
    default:
      return true;
  }
}

const CANONICAL_RANK: Record<ProjectTask['canonical'], number> = {
  waiting: 0,
  scheduled: 1,
  next: 2,
  inbox: 3,
  someday: 4,
  done: 5,
  canceled: 6
};

function formatDue(due: string | null) {
  if (!due) return null;
  const day = due.slice(0, 10);
  const parsed = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  return parsed.toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'});
}

function groupProjects(tasks: ProjectTask[]) {
  const groups = new Map<string, ProjectTask[]>();
  for (const task of tasks) {
    const key = task.project?.trim() || 'No project';
    const list = groups.get(key) ?? [];
    list.push(task);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === 'No project' ? 1 : b === 'No project' ? -1 : a.localeCompare(b)))
    .map(([name, items]) => ({
      name,
      items: [...items].sort((a, b) => CANONICAL_RANK[a.canonical] - CANONICAL_RANK[b.canonical] || a.title.localeCompare(b.title))
    }));
}

export function ProjectsView() {
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [note, setNote] = useState('');
  const [health, setHealth] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<ProjectFilter>('open');
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [celebrateId, setCelebrateId] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function load() {
    const res = await fetch('/api/projects', {cache: 'no-store'});
    const json = await res.json().catch(() => null);
    if (res.status === 401) return void (window.location.href = '/login');
    if (!res.ok) return setHealth(json?.error?.message ?? 'Could not load projects.');
    setTasks(json.tasks ?? []);
    setHealth(json.health?.state !== 'connected' ? json.health?.message ?? 'Notion is not connected.' : '');
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      void load()
        .catch(() => setHealth('Could not load projects.'))
        .finally(() => setLoaded(true));
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  async function markDone(taskId: string) {
    if (completingId) return;
    setCompletingId(taskId);
    setError('');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({taskId, kind: 'done'})
      });
      const body = await res.json().catch(() => null);
      if (res.status === 401) return void (window.location.href = '/login');
      const ok = body?.notion === 'marked_done' || body?.notion === 'already_done';
      if (!res.ok || !ok) {
        setError(body?.error?.message ?? body?.message ?? 'Could not mark that task Done.');
        return;
      }
      setTasks((prev) =>
        prev.map((task) => (task.id === taskId ? {...task, canonical: 'done', notionStatus: 'Done', nextAction: 'You marked this done in Deevaa'} : task))
      );
      setCelebrateId(taskId);
      await load();
      setNote(body.message ?? 'Marked Done in Notion.');
    } finally {
      setCompletingId(null);
    }
  }

  const visible = tasks.filter((task) => projectFilterMatch(task, filter));
  const groups = groupProjects(visible);
  const openCount = tasks.filter((task) => projectFilterMatch(task, 'open')).length;
  return (
    <section className="panel" aria-labelledby="projects-title">
      <div className="panel-head">
        <h2 id="projects-title">Projects</h2>
        {loaded && <span className="muted small">{openCount} open</span>}
      </div>
      <p className="muted">From Notion. Mark a task Done here to update Notion, or open it there to edit more.</p>
      {error && <p className="warning" role="alert">{error}</p>}
      {note && <p className="notice">{note}</p>}
      {health && <p className="muted">{health}</p>}
      <fieldset className="windows">
        <legend className="small muted">Show</legend>
        {PROJECT_FILTERS.map((item) => (
          <button key={item.id} type="button" className={filter === item.id ? 'chip on' : 'chip'} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>
            {item.label}
          </button>
        ))}
      </fieldset>
      {!loaded && !health && <p className="muted">Loading tasks…</p>}
      {loaded && !groups.length && <p className="muted">{filter === 'open' ? 'Nothing is open.' : 'No tasks in this view.'}</p>}
      {groups.map((group) => (
        <section key={group.name} className="project-group" aria-label={group.name}>
          <h3 className="project-group-title">
            {group.name} <span className="muted small">{group.items.length}</span>
          </h3>
          <ul className="plain">
            {group.items.map((task) => {
              const canComplete = task.canonical !== 'done' && task.canonical !== 'canceled';
              const busy = completingId === task.id;
              return (
                <li key={task.id} className={`task${celebrateId === task.id ? ' done-celebrate' : ''}`}>
                  <div>
                    <span className={`badge lane-badge badge-${CANONICAL_BADGE[task.canonical] ?? 'not_connected'}`}>{CANONICAL_LABEL[task.canonical] ?? task.notionStatus}</span>
                    <strong>{task.title}</strong>
                    <small>
                      {[formatDue(task.due) ? `Due ${formatDue(task.due)}` : null, task.nextAction].filter(Boolean).join(' · ') || task.notionStatus}
                    </small>
                    {celebrateId === task.id && (
                      <p className="done-toast" role="status">
                        Done — nice work.
                      </p>
                    )}
                    <div className="feedback" role="group" aria-label={`Actions for ${task.title}`}>
                      {canComplete && (
                        <button type="button" className="done-btn" onClick={() => markDone(task.id)} disabled={!!completingId} aria-busy={busy}>
                          {busy ? 'Marking…' : 'Done'}
                        </button>
                      )}
                      {task.url && (
                        <a href={task.url} target="_blank" rel="noreferrer">
                          Open in Notion<span className="visually-hidden">: {task.title} (opens in new tab)</span>
                        </a>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
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
