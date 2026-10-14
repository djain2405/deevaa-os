'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {BlueprintPanel} from './blueprint-panel';
import {ChatPanel} from './chat-panel';
import type {Connections} from '@/lib/briefing-view';
import {ACTION_WINDOWS, CONTEXTS, ENERGY_LEVELS, findNextAction, type Feedback, type FeedbackKind, type NextAction} from '@/lib/next-action';
import type {AgentDeliverable, Block, BriefingSnapshot, Context, DecisionLane, Energy, RadarItem, RankedTask, SourceHealth, TaskRef} from '@/lib/types';

type RunView = {id: string; trigger: string; status: string; errorCode: string | null; startedAt: string; finishedAt: string | null};
type Payload = {
  date: string;
  today: string;
  briefing: (BriefingSnapshot & {updatedAt: string}) | null;
  lastRun: RunView | null;
  connections: Connections;
  feedback: Feedback[];
  warnings: string[];
};

const RADAR_LABEL: Record<RadarItem['kind'], string> = {
  blocked_deadline: 'Blocked, deadline close',
  overdue: 'Overdue',
  due_soon: 'Due soon',
  stale_waiting: 'Follow up',
  verify_deadline: 'Verify deadline'
};

type TaskFilter = 'attention' | 'ready' | 'scheduled' | 'waiting_blocked' | 'someday' | 'completed';

const TASK_FILTERS: {id: TaskFilter; label: string}[] = [
  {id: 'attention', label: 'Needs attention'},
  {id: 'ready', label: 'Ready'},
  {id: 'scheduled', label: 'Scheduled'},
  {id: 'waiting_blocked', label: 'Waiting / Blocked'},
  {id: 'someday', label: 'Someday'},
  {id: 'completed', label: 'Completed'}
];

function LaneBadge({lane}: {lane: DecisionLane}) {
  const urgent = lane === 'Critical' || lane === 'Due soon';
  return <span className={`badge lane-badge ${urgent ? 'lane-urgent' : lane === 'Important' ? 'lane-important' : ''}`}>{lane}</span>;
}

function taskMatchesFilter(t: RankedTask, filter: TaskFilter, attentionIds: Set<string>) {
  switch (filter) {
    case 'attention':
      return attentionIds.has(t.id) || t.lane === 'Verify';
    case 'ready':
      return t.executable && (t.lane === 'Critical' || t.lane === 'Due soon' || t.lane === 'Important');
    case 'scheduled':
      return t.lane === 'Scheduled';
    case 'waiting_blocked':
      return t.lane === 'Waiting' || t.lane === 'Blocked';
    case 'someday':
      return t.lane === 'Someday';
    case 'completed':
      return t.lane === 'Completed';
    default:
      return true;
  }
}

const FEEDBACK_BUTTONS: {kind: FeedbackKind; label: string}[] = [
  {kind: 'done', label: 'Done'},
  {kind: 'not_now', label: 'Not now'},
  {kind: 'not_possible_here', label: 'Not possible here'},
  {kind: 'wrong', label: 'Wrong recommendation'}
];

const TZ = 'America/Los_Angeles';
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', timeZone: TZ});
const stamp = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TZ});
const longDate = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', {weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC'});

const CALENDAR_MESSAGES: Record<string, string> = {
  connected: 'Google Calendar connected with read-only access. Regenerate to include it.',
  denied: 'Google Calendar access was not granted. Nothing was stored.',
  invalid_state: 'That connection attempt expired or did not match this session. Try again.',
  scope: 'Google granted more than read-only access, so the connection was refused.',
  no_refresh_token: 'Google did not grant offline access. Remove Deevaa under Google Account > Security > Third-party access, then connect again.',
  config: 'Google OAuth is not configured on the server.',
  revoked: 'Google rejected the authorization. Try connecting again.',
  unavailable: 'Google could not be reached. Try again shortly.'
};

const TRIGGER_LABEL: Record<string, string> = {cron: 'scheduled run', manual: 'you', initial: 'first load'};

function StateBadge({state}: {state: 'connected' | 'not_connected' | 'error' | 'pending'}) {
  const label = {connected: 'Connected', not_connected: 'Not connected', error: 'Error', pending: 'Configured, not read yet'}[state];
  return <span className={`badge badge-${state}`}>{label}</span>;
}

function TaskLinks({task}: {task: TaskRef}) {
  return (
    <span className="links">
      <a href={task.url} target="_blank" rel="noreferrer">
        Open in Notion<span className="visually-hidden">: {task.title} (opens in new tab)</span>
      </a>
      {task.sourceLink && (
        <a href={task.sourceLink} target="_blank" rel="noreferrer">
          Evidence<span className="visually-hidden"> for {task.title} (opens in new tab)</span>
        </a>
      )}
    </span>
  );
}

function SourceRow({name, health, fallback, children}: {name: string; health?: SourceHealth; fallback: 'not_connected' | 'pending' | 'error'; children?: React.ReactNode}) {
  return (
    <li className="conn">
      <div>
        <strong>{name}</strong> <StateBadge state={health?.state ?? fallback} />
        {health && <p className="muted">{health.message}{health.lastSyncedAt ? ` Last synced ${stamp(health.lastSyncedAt)}.` : ''}</p>}
      </div>
      {children}
    </li>
  );
}

function BlockRow({block}: {block: Block}) {
  const when = block.state === 'scheduled' && block.start && block.end ? `${time(block.start)} – ${time(block.end)}` : block.state === 'omitted' ? 'Skipped' : 'No time claimed';
  return (
    <li className={`block block-${block.state}`}>
      <span className="block-label">{block.label}</span>
      <div>
        <p className="block-when">{when}</p>
        <strong>{block.task ? block.task.title : block.label === 'EXPAND' && block.state !== 'omitted' ? 'Open time, no task assigned' : 'Nothing scheduled'}</strong>
        <p>{block.reason}</p>
        {block.aiNote && <p className="ai-note"><span>AI note:</span> {block.aiNote}</p>}
        {block.task && <TaskLinks task={block.task} />}
      </div>
    </li>
  );
}

export default function Dashboard({email, signOutAction}: {email: string; signOutAction: () => Promise<void>}) {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [minutes, setMinutes] = useState<number>(10);
  const [energy, setEnergy] = useState<Energy>('Low');
  const [context, setContext] = useState<Context>('Anywhere');
  const [action, setAction] = useState<NextAction | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [topSkipped, setTopSkipped] = useState<string[]>([]);
  const [whyOpen, setWhyOpen] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('ready');
  const [writes, setWrites] = useState<'granted' | 'off' | null>(null);
  const autoStarted = useRef(false);

  const loadWrites = useCallback(async () => {
    const res = await fetch('/api/permissions', {cache: 'no-store'});
    if (!res.ok) return;
    const body = await res.json();
    setWrites(body.permissions.notion_task_write.status === 'granted' ? 'granted' : 'off');
  }, []);

  async function toggleWrites() {
    const granting = writes !== 'granted';
    if (
      granting &&
      !window.confirm(
        'Let Deevaa create and update tasks in your Deevaa Tasks database from what you tell it in chat, and publish your Life Blueprint as a Notion page under the same parent?\n\nIt only changes task fields (title, status, due date, priority, duration, project, next action), verifies every write, and keeps an undo record. It never deletes tasks, sends messages, books anything or edits your calendar. You can turn this off at any time.'
      )
    )
      return;
    const res = await fetch('/api/permissions', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({permission: 'notion_task_write', status: granting ? 'granted' : 'revoked'})
    });
    setNotice(res.ok ? (granting ? 'Notion task updates are on.' : 'Notion task updates are off. Deevaa will only propose changes.') : 'Could not change Notion task updates.');
    await loadWrites();
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/briefing', {cache: 'no-store'});
      if (res.status === 401) return void (window.location.href = '/login');
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? 'Could not load the briefing.');
      if (!body) throw new Error('Could not load the briefing.');
      setData(body);
      setError('');
      return body as Payload;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the briefing.');
    } finally {
      setLoading(false);
    }
  }, []);

  const regenerate = useCallback(
    async (key: string, date?: string) => {
      setBusy(true);
      setError('');
      try {
        const res = await fetch('/api/briefing/regenerate', {
          method: 'POST',
          headers: {'Content-Type': 'application/json', 'Idempotency-Key': key},
          body: JSON.stringify(date ? {date} : {})
        });
        if (res.status === 401) return void (window.location.href = '/login');
        const body = await res.json().catch(() => null);
        if (!res.ok) setError(body?.error?.message ?? 'The briefing could not be generated.');
        else if (!body) setError('The briefing could not be generated.');
        else if (body.outcome === 'kept_previous') setNotice('A source failed during refresh, so the previous briefing was kept.');
        else setNotice(body.outcome === 'duplicate' ? 'That refresh already ran.' : 'Briefing regenerated from the connected sources.');
        setAction(null);
        setTopSkipped([]);
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const cal = params.get('calendar');
    if (cal) {
      setNotice(CALENDAR_MESSAGES[cal] ?? 'Google Calendar connection finished.');
      window.history.replaceState(null, '', '/');
    }
    loadWrites();
    load().then((p) => {
      if (p && !p.briefing && !p.lastRun && !autoStarted.current) {
        autoStarted.current = true;
        regenerate(`initial-${p.date}`);
      }
    });
  }, [load, loadWrites, regenerate]);

  async function disconnect() {
    if (!window.confirm('Disconnect Google Calendar? Deevaa will forget its read-only access.')) return;
    const res = await fetch('/api/google/disconnect', {method: 'POST'});
    setNotice(res.ok ? 'Google Calendar disconnected.' : 'Could not disconnect Google Calendar.');
    await load();
  }

  function choose(skip: string[] = [], feedback: Feedback[] = data?.feedback ?? [], tasks = data?.briefing?.tasks) {
    if (!tasks) return;
    setSkipped(skip);
    setAction(findNextAction(tasks, {minutes, energy, context, skipIds: skip, feedback}));
  }

  async function sendFeedback(taskId: string, kind: FeedbackKind) {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({taskId, kind, minutes, energy, context})
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return setError(body?.error?.message ?? 'Feedback could not be saved.');
    setNotice(body.message);
    const local: Feedback = {taskId, kind, context, createdAt: new Date().toISOString()};
    const next = await load();
    choose([...skipped, ...(kind === 'done' ? [taskId] : [])], [...(next?.feedback ?? data?.feedback ?? []), local], next?.briefing?.tasks ?? data?.briefing?.tasks);
  }

  const b = data?.briefing ?? null;
  const conn = data?.connections;
  const ready = b?.tasks.filter((t) => t.executable) ?? [];
  const attentionIds = new Set((b?.radar ?? []).map((r) => r.task.id));
  const topVisible = (b?.topOutcomes ?? []).filter((o) => !topSkipped.includes(o.task.id));
  const filteredTasks = b?.tasks.filter((t) => taskMatchesFilter(t, taskFilter, attentionIds)) ?? [];
  const calendarFallback = conn?.calendar.state === 'revoked' ? 'error' : conn?.calendar.state === 'connected' ? 'pending' : 'not_connected';

  function skipTop(taskId: string) {
    setTopSkipped((prev) => (prev.includes(taskId) ? prev : [...prev, taskId]));
  }

  return (
    <>
      <a className="skip" href="#briefing">Skip to briefing</a>
      <main>
        <header>
          <div className="brand">
            ✦ <strong>Deevaa OS</strong>
            <span>Chief of Staff</span>
          </div>
          <div className="header-actions">
            <span className="muted who">{email}</span>
            <button type="button" onClick={() => regenerate(crypto.randomUUID())} disabled={busy || loading} aria-busy={busy}>
              {busy ? 'Preparing…' : '↻ Regenerate'}
            </button>
            <form action={signOutAction}>
              <button type="submit" className="ghost">Sign out</button>
            </form>
          </div>
        </header>

        <section className="hero" aria-labelledby="hero-title">
          <p className="eyebrow">{data ? longDate(data.date) : 'Loading'}</p>
          <h1 id="hero-title">
            {b ? (data?.date === data?.today ? 'Today’s briefing' : 'Briefing') : loading ? 'Loading your briefing…' : busy ? 'Preparing your first briefing…' : 'No briefing yet.'}
          </h1>
          {b && <p className="summary">{b.summary}</p>}
          {b && (
            <p className="status">
              <b className={`pill pill-${b.status}`}>{b.status === 'complete' ? 'Complete' : b.status === 'partial' ? 'Partial' : 'Unavailable'}</b>
              {' · '}Updated {stamp(b.generatedAt)}
              {data?.lastRun?.status === 'succeeded' && ` by ${TRIGGER_LABEL[data.lastRun.trigger] ?? 'a run'}`}
              {b.ai.status === 'applied' ? ' · AI explanations shown' : ''}
            </p>
          )}
        </section>

        <div aria-live="polite" role="status">
          {notice && <p className="notice">{notice}</p>}
          {error && <p className="warning">{error}</p>}
        </div>

        {(data?.warnings.length || b?.warnings.length) ? (
          <section className="warning" aria-label="Warnings">
            <ul>
              {[...(data?.warnings ?? []), ...(b?.warnings ?? [])].map((w, i) => (
                <li key={i}>⚠ {w}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {b && (
          <div id="briefing">
            {(b.radar?.length ?? 0) > 0 && (
              <section className="panel radar" aria-labelledby="radar-title">
                <h2 id="radar-title">Needs attention</h2>
                <p className="muted">Deadlines, blocked work, stale waiting, and uncertain due dates. Deevaa only warns; it does not contact anyone.</p>
                <ul className="plain">
                  {b.radar!.map((r) => (
                    <li key={`${r.kind}-${r.task.id}`}>
                      <span className="badge">{RADAR_LABEL[r.kind]}</span> <strong>{r.task.title}</strong>
                      {r.task.url && <a href={r.task.url} target="_blank" rel="noreferrer">Open in Notion</a>}
                      <p className="muted">{r.detail}</p>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {topVisible.length > 0 && (
              <section className="panel" aria-labelledby="top-title">
                <h2 id="top-title">Top 3 priorities</h2>
                <ol className="outcomes">
                  {topVisible.map((o) => (
                    <li key={o.task.id}>
                      <LaneBadge lane={o.lane} /> <strong>{o.task.title}</strong>
                      {whyOpen === o.task.id && <p className="muted">{o.reasons.join(' · ') || 'Ready in Notion'}</p>}
                      {whyOpen !== o.task.id && <p className="muted">Next: {o.nextAction}</p>}
                      {o.aiNote && <p className="ai-note"><span>AI note:</span> {o.aiNote}</p>}
                      <TaskLinks task={o.task} />
                      <div className="feedback" role="group" aria-label={`Feedback for ${o.task.title}`}>
                        <button type="button" className="ghost" onClick={() => setWhyOpen(whyOpen === o.task.id ? null : o.task.id)} aria-expanded={whyOpen === o.task.id}>
                          Why this?
                        </button>
                        <button type="button" className="ghost" onClick={() => sendFeedback(o.task.id, 'not_now')}>Not now</button>
                        <button type="button" className="ghost" onClick={() => sendFeedback(o.task.id, 'wrong')}>Wrong priority</button>
                        <button type="button" onClick={() => sendFeedback(o.task.id, 'done')}>Done</button>
                        <button type="button" className="ghost" onClick={() => skipTop(o.task.id)}>Choose another</button>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <div className="columns">
              <section className="panel" aria-labelledby="blocks-title">
                <h2 id="blocks-title">Today’s blocks</h2>
                <p className="muted">Suggestions only. Deevaa does not create or change calendar events.</p>
                <ul className="plain">{b.blocks.map((x) => <BlockRow key={x.label} block={x} />)}</ul>
              </section>

              <section className="panel" aria-labelledby="calendar-title">
                <h2 id="calendar-title">Calendar</h2>
                {b.capacity.known ? (
                  <p className="muted">
                    {`${b.capacity.freeMinutes! >= 60 ? `${Math.floor(b.capacity.freeMinutes! / 60)}h ` : ''}${b.capacity.freeMinutes! % 60}m`} open between 7:00 AM and 10:30 PM, after 10-minute preparation and transition buffers.
                  </p>
                ) : (
                  <p className="muted">Calendar not available, so free time is unknown and no windows are claimed.</p>
                )}
                {b.events.length ? (
                  <ul className="plain">
                    {[...b.events].sort((x, y) => Number(y.allDay) - Number(x.allDay)).map((e) => (
                      <li className="event" key={`${e.calendarId}-${e.id}`}>
                        <span>{e.allDay ? 'All day' : `${time(e.start)} – ${time(e.end)}`}</span>
                        <strong>
                          {e.htmlLink ? <a href={e.htmlLink} target="_blank" rel="noreferrer">{e.title}</a> : e.title}
                          {!e.busy && !e.allDay && <small> (free)</small>}
                        </strong>
                      </li>
                    ))}
                  </ul>
                ) : b.capacity.known ? (
                  <p className="muted">No events on this day.</p>
                ) : null}

                <h2 className="space" id="next-title">Find my next action</h2>
                <fieldset className="windows">
                  <legend className="small muted">Time available</legend>
                  {ACTION_WINDOWS.map((m) => (
                    <button key={m} type="button" className={minutes === m ? 'chip on' : 'chip'} aria-pressed={minutes === m} onClick={() => setMinutes(m)}>
                      {m} min
                    </button>
                  ))}
                </fieldset>
                <div className="fields">
                  <label>
                    Energy
                    <select value={energy} onChange={(e) => setEnergy(e.target.value as Energy)}>
                      {ENERGY_LEVELS.map((x) => <option key={x}>{x}</option>)}
                    </select>
                  </label>
                  <label>
                    Where you are
                    <select value={context} onChange={(e) => setContext(e.target.value as Context)}>
                      {CONTEXTS.map((x) => <option key={x}>{x}</option>)}
                    </select>
                  </label>
                </div>
                <button type="button" className="cta" onClick={() => choose()} disabled={!ready.length && !b.tasks.length}>
                  Choose one action →
                </button>
                <div aria-live="polite">
                  {action?.kind === 'task' && (
                    <div className="selected">
                      <b>{action.task.title}</b>
                      <p>{action.reason}</p>
                      <p>{action.doneDefinition}</p>
                      <TaskLinks task={action.task} />
                      <div className="feedback" role="group" aria-label="How did this recommendation work?">
                        {FEEDBACK_BUTTONS.map((f) => (
                          <button key={f.kind} type="button" className={f.kind === 'done' ? '' : 'ghost'} onClick={() => sendFeedback(action.task.id, f.kind)}>
                            {f.label}
                          </button>
                        ))}
                        <button type="button" className="ghost" onClick={() => choose([...skipped, action.task.id])}>
                          Something else
                        </button>
                      </div>
                    </div>
                  )}
                  {action?.kind === 'rest' && (
                    <div className="selected">
                      <b>Rest or transition</b>
                      <p>{action.reason}</p>
                    </div>
                  )}
                </div>
              </section>
            </div>

            {(b.waiting?.length ?? 0) > 0 && (
              <section className="panel" aria-labelledby="waiting-title">
                <h2 id="waiting-title">Waiting</h2>
                <p className="muted">No action from you until they reply.</p>
                <ul className="plain">
                  {b.waiting!.map((t) => (
                    <li key={t.id} className="task">
                      <div>
                        <LaneBadge lane={t.lane} /> <strong>{t.title}</strong>
                        <small>{t.excludedReason ?? t.status}</small>
                      </div>
                      <TaskLinks task={t} />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {(b.agentWork?.length ?? 0) > 0 && (
              <section className="panel" aria-labelledby="agents-title">
                <h2 id="agents-title">Agents prepared</h2>
                <p className="muted">Derived from this briefing only — not a simulated run log.</p>
                <ul className="plain">
                  {b.agentWork!.map((a: AgentDeliverable) => (
                    <li key={a.agent} className="task">
                      <div>
                        <strong>{a.agent}</strong> <span className="badge badge-connected">{a.status}</span>
                        <small>{a.summary}</small>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <details className="panel">
              <summary>
                <h2 className="inline-title">All tasks ({b.tasks.length})</h2>
              </summary>
              <fieldset className="windows">
                <legend className="small muted">Filter</legend>
                {TASK_FILTERS.map((f) => (
                  <button key={f.id} type="button" className={taskFilter === f.id ? 'chip on' : 'chip'} aria-pressed={taskFilter === f.id} onClick={() => setTaskFilter(f.id)}>
                    {f.label}
                  </button>
                ))}
              </fieldset>
              {filteredTasks.length ? (
                <ul className="plain">
                  {filteredTasks.map((t) => (
                    <li key={t.id} className="task">
                      <div>
                        <LaneBadge lane={t.lane} /> <strong>{t.title}</strong>
                        <small>
                          {t.status} · {t.priority === 'None' ? 'No priority' : t.priority} · {t.duration ? `${t.duration}m` : 'no duration'}
                          {t.due ? ` · due ${t.due.slice(0, 10)}` : ''}
                        </small>
                        {t.excludedReason && <small>{t.excludedReason}</small>}
                        {!t.excludedReason && t.reasons.length > 0 && <small>Why: {t.reasons.join(' · ')}</small>}
                      </div>
                      <TaskLinks task={t} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No tasks match this filter.</p>
              )}
            </details>
          </div>
        )}

        <details className="panel">
          <summary>Chat & task intake</summary>
          <ChatPanel writes={writes} onChanged={load} />
        </details>

        <details className="panel">
          <summary>Connections & scheduling</summary>
          <section aria-labelledby="sources-title">
            <h2 id="sources-title" className="visually-hidden">Connections</h2>
            <ul className="conns">
              <SourceRow name="Notion tasks" health={b?.sources.notion} fallback={conn?.notion === 'configured' ? 'pending' : 'not_connected'}>
                {conn?.notion === 'not_configured' && !b && <p className="muted small">Set NOTION_TOKEN and NOTION_DATA_SOURCE_ID on the server.</p>}
                {conn?.notion === 'configured' && writes && (
                  <div className="row-actions">
                    <span className="muted small">Notion task updates and Life Blueprint publish: {writes === 'granted' ? 'On' : 'Off'}</span>
                    <button type="button" className={writes === 'granted' ? 'ghost' : ''} onClick={toggleWrites} aria-pressed={writes === 'granted'}>
                      {writes === 'granted' ? 'Turn off' : 'Turn on'}
                    </button>
                  </div>
                )}
              </SourceRow>
              <SourceRow name="Google Calendar (read-only)" health={b && conn?.calendar.state !== 'not_connected' ? b.sources.calendar : undefined} fallback={calendarFallback}>
                {conn?.calendar.state === 'connected' ? (
                  <div className="row-actions">
                    <span className="muted small">{conn.calendar.calendarCount} calendar(s)</span>
                    <button type="button" className="ghost" onClick={disconnect}>Disconnect</button>
                  </div>
                ) : (
                  <form method="post" action="/api/google/connect">
                    <button type="submit">{conn?.calendar.state === 'revoked' ? 'Reconnect' : 'Connect'} Google Calendar</button>
                  </form>
                )}
              </SourceRow>
              <li className="conn">
                <div>
                  <strong>AI explanations</strong> <span className={`badge badge-${conn?.ai === 'enabled' ? 'connected' : 'not_connected'}`}>{conn?.ai === 'enabled' ? 'On' : 'Off'}</span>
                  <p className="muted">{b?.ai.detail ?? (conn?.ai === 'enabled' ? 'Optional wording on top of the deterministic plan.' : 'Plans are deterministic; set OPENAI_API_KEY for optional explanations.')}</p>
                </div>
              </li>
              <li className="conn">
                <div>
                  <strong>Scheduled briefing</strong>{' '}
                  <span className={`badge badge-${conn?.scheduler.lastStatus === 'succeeded' ? 'connected' : conn?.scheduler.lastStatus === 'failed' ? 'error' : 'not_connected'}`}>
                    {conn?.scheduler.lastRunAt ? (conn.scheduler.lastStatus === 'succeeded' ? 'Last run succeeded' : `Last run ${conn.scheduler.lastStatus}`) : 'No run recorded'}
                  </span>
                  <p className="muted">
                    {conn?.scheduler.lastRunAt
                      ? `A scheduler called Deevaa at ${stamp(conn.scheduler.lastRunAt)}.`
                      : 'Nothing has triggered a nightly briefing yet. Scheduling is only active once the app is deployed and a cron call has succeeded.'}
                  </p>
                </div>
              </li>
            </ul>
          </section>
        </details>

        <details className="panel blueprint" open>
          <summary>Life Blueprint (ranking source — optional Notion copy)</summary>
          <BlueprintPanel onSaved={() => regenerate(crypto.randomUUID())} />
        </details>

        <footer>
          Deevaa reads Google Calendar without changing it. It changes Notion tasks only when task updates are on, and only from what you tell it. It never sends messages, books, publishes or deletes, and it records a task as done only when you say so. Recommendations are suggestions for you to act on.
        </footer>
      </main>
    </>
  );
}
