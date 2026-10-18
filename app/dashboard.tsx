'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import type {Connections} from '@/lib/briefing-view';
import {ACTION_WINDOWS, CONTEXTS, ENERGY_LEVELS, findNextAction, type Feedback, type FeedbackKind, type NextAction} from '@/lib/next-action';
import type {Block, BriefingSnapshot, Context, DecisionLane, Energy, RadarItem, TaskRef} from '@/lib/types';

type RunView = {id: string; trigger: string; status: string; errorCode: string | null; startedAt: string; finishedAt: string | null};
type EmailItemState = {permalink: string; kind: 'hidden' | 'saved'; pageUrl: string | null};
type Payload = {
  date: string;
  today: string;
  briefing: (BriefingSnapshot & {updatedAt: string}) | null;
  lastRun: RunView | null;
  connections: Connections;
  emailItems: EmailItemState[];
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

function LaneBadge({lane}: {lane: DecisionLane}) {
  const urgent = lane === 'Critical' || lane === 'Due soon';
  return <span className={`badge lane-badge ${urgent ? 'lane-urgent' : lane === 'Important' ? 'lane-important' : ''}`}>{lane}</span>;
}

const FEEDBACK_BUTTONS: {kind: FeedbackKind; label: string}[] = [
  {kind: 'done', label: 'Done'},
  {kind: 'not_now', label: 'Not now'},
  {kind: 'not_possible_here', label: 'Not possible here'},
  {kind: 'wrong', label: 'Wrong recommendation'}
];

type FeedbackResponse = {notion?: string; message?: string};

function DoneButton({
  taskId,
  completingId,
  onDone
}: {
  taskId: string;
  completingId: string | null;
  onDone: (id: string) => void;
}) {
  const busy = completingId === taskId;
  const locked = completingId !== null && !busy;
  return (
    <button type="button" className="done-btn" onClick={() => onDone(taskId)} disabled={locked || busy} aria-busy={busy}>
      {busy ? 'Marking…' : 'Done'}
    </button>
  );
}

function DoneToast({taskId, celebrateId}: {taskId: string; celebrateId: string | null}) {
  if (celebrateId !== taskId) return null;
  return (
    <p className="done-toast" role="status">
      Done — nice work.
    </p>
  );
}

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

const GMAIL_MESSAGES: Record<string, string> = {
  connected: 'Gmail connected with read-only access. Run the morning digest to include today’s mail.',
  denied: 'Gmail access was not granted. Nothing was stored.',
  invalid_state: 'That connection attempt expired or did not match this session. Try again.',
  scope: 'Google granted more than read-only Gmail access, so the connection was refused.',
  no_refresh_token: 'Google did not grant offline access. Remove Deevaa under Google Account > Security > Third-party access, then connect again.',
  config: 'Google OAuth is not configured on the server.',
  revoked: 'Google rejected the authorization. Try connecting again.',
  unavailable: 'Google could not be reached. Try again shortly.'
};

const TRIGGER_LABEL: Record<string, string> = {cron: 'scheduled run', manual: 'you', initial: 'first load', agent: 'email agent'};

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

function BlockRow({
  block,
  completingId,
  celebrateId,
  hiddenTaskIds,
  onDone
}: {
  block: Block;
  completingId: string | null;
  celebrateId: string | null;
  hiddenTaskIds: Set<string>;
  onDone: (id: string) => void;
}) {
  const when = block.state === 'scheduled' && block.start && block.end ? `${time(block.start)} – ${time(block.end)}` : block.state === 'omitted' ? 'Skipped' : 'No time claimed';
  const task = block.task;
  if (task && hiddenTaskIds.has(task.id)) return null;
  return (
    <li className={`block block-${block.state}${task && celebrateId === task.id ? ' done-celebrate' : ''}`}>
      <span className="block-label">{block.label}</span>
      <div>
        <p className="block-when">{when}</p>
        <strong>{task ? task.title : block.label === 'EXPAND' && block.state !== 'omitted' ? 'Open time, no task assigned' : 'Nothing scheduled'}</strong>
        <p>{block.reason}</p>
        {block.aiNote && <p className="ai-note"><span>AI note:</span> {block.aiNote}</p>}
        {task && <TaskLinks task={task} />}
        {task && (
          <div className="feedback" role="group" aria-label={`Mark ${task.title} done`}>
            <DoneButton taskId={task.id} completingId={completingId} onDone={onDone} />
            <DoneToast taskId={task.id} celebrateId={celebrateId} />
          </div>
        )}
      </div>
    </li>
  );
}

export default function Dashboard() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [gmailBusy, setGmailBusy] = useState(false);
  const [emailActing, setEmailActing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [minutes, setMinutes] = useState<number>(10);
  const [energy, setEnergy] = useState<Energy>('Low');
  const [context, setContext] = useState<Context>('Anywhere');
  const [action, setAction] = useState<NextAction | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [topSkipped, setTopSkipped] = useState<string[]>([]);
  const [whyOpen, setWhyOpen] = useState<string | null>(null);
  const [writes, setWrites] = useState<'granted' | 'off' | null>(null);
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [completedIds, setCompletedIds] = useState<string[]>([]);
  const [celebrateId, setCelebrateId] = useState<string | null>(null);
  const autoStarted = useRef(false);
  const celebrateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hiddenTaskIds = new Set(completedIds);

  const loadWrites = useCallback(async () => {
    const res = await fetch('/api/permissions', {cache: 'no-store'});
    if (!res.ok) return;
    const body = await res.json();
    setWrites(body.permissions.notion_task_write.status === 'granted' ? 'granted' : 'off');
  }, []);

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
    const gmail = params.get('gmail');
    if (cal) {
      setNotice(CALENDAR_MESSAGES[cal] ?? 'Google Calendar connection finished.');
      window.history.replaceState(null, '', '/');
    } else if (gmail) {
      setNotice(GMAIL_MESSAGES[gmail] ?? 'Gmail connection finished.');
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

  async function actOnEmail(permalink: string, action: 'hide' | 'save') {
    setEmailActing(`${action}:${permalink}`);
    setError('');
    try {
      const res = await fetch('/api/jobs/gmail/item', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({permalink, action})
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error?.message ?? 'Could not update that email item.');
        return;
      }
      setNotice(
        action === 'hide'
          ? 'Hidden. It will stay off the digest unless you reconnect a new copy of that thread.'
          : body?.created
            ? 'Added to Notion as a Ready task with the quoted due date, if any.'
            : 'Already tracked in Notion.'
      );
      await load();
    } finally {
      setEmailActing(null);
    }
  }

  async function runGmailDigest() {
    setGmailBusy(true);
    setError('');
    try {
      const res = await fetch('/api/jobs/gmail', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID()}
      });
      if (res.status === 401) return void (window.location.href = '/login');
      const body = await res.json().catch(() => null);
      if (!res.ok) setError(body?.error?.message ?? 'The Gmail digest could not be generated.');
      else setNotice(body?.outcome === 'duplicate' ? 'That Gmail digest already ran.' : 'Morning email digest updated.');
      await load();
    } finally {
      setGmailBusy(false);
    }
  }

  function choose(skip: string[] = [], feedback: Feedback[] = data?.feedback ?? [], tasks = data?.briefing?.tasks) {
    if (!tasks) return;
    setSkipped(skip);
    setAction(findNextAction(tasks, {minutes, energy, context, skipIds: skip, feedback}));
  }

  async function markTaskDone(taskId: string) {
    if (completingId) return;
    setCompletingId(taskId);
    setError('');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({taskId, kind: 'done', minutes, energy, context})
      });
      const body = (await res.json().catch(() => null)) as FeedbackResponse | null;
      if (!res.ok) {
        const err = body as {error?: {message?: string}} | null;
        setError(err?.error?.message ?? 'Could not mark that task Done.');
        return;
      }
      const ok = body?.notion === 'marked_done' || body?.notion === 'already_done';
      if (ok) {
        setCompletedIds((prev) => (prev.includes(taskId) ? prev : [...prev, taskId]));
        setCelebrateId(taskId);
        if (celebrateTimer.current) clearTimeout(celebrateTimer.current);
        celebrateTimer.current = setTimeout(() => setCelebrateId((c) => (c === taskId ? null : c)), 5000);
      }
      if (body?.message) setNotice(body.message);
      if (!ok) return;
      const local: Feedback = {taskId, kind: 'done', context, createdAt: new Date().toISOString()};
      const next = await load();
      choose([...skipped, taskId], [...(next?.feedback ?? data?.feedback ?? []), local], next?.briefing?.tasks ?? data?.briefing?.tasks);
      if (action?.kind === 'task' && action.task.id === taskId) setAction(null);
    } finally {
      setCompletingId(null);
    }
  }

  async function sendFeedback(taskId: string, kind: FeedbackKind) {
    if (kind === 'done') return markTaskDone(taskId);
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
    choose(skipped, [...(next?.feedback ?? data?.feedback ?? []), local], next?.briefing?.tasks ?? data?.briefing?.tasks);
  }

  const b = data?.briefing ?? null;
  const conn = data?.connections;
  const ready = b?.tasks.filter((t) => t.executable) ?? [];
  const topVisible = (b?.topOutcomes ?? []).filter((o) => !topSkipped.includes(o.task.id) && !hiddenTaskIds.has(o.task.id));
  const digest = b?.emailDigest;
  const emailState = new Map((data?.emailItems ?? []).map((i) => [i.permalink, i]));
  const visibleActions = (digest?.actions ?? []).filter((a) => emailState.get(a.permalink)?.kind !== 'hidden');
  const visibleSummaries = (digest?.summaries ?? []).filter((s) => emailState.get(s.permalink)?.kind !== 'hidden');
  const needsSetup = conn && (conn.gmail.state !== 'connected' || conn.calendar.state !== 'connected');
  const freeLabel = b?.capacity.known
    ? `${b.capacity.freeMinutes! >= 60 ? `${Math.floor(b.capacity.freeMinutes! / 60)}h ` : ''}${b.capacity.freeMinutes! % 60}m open today`
    : 'Free time unknown';

  function skipTop(taskId: string) {
    setTopSkipped((prev) => (prev.includes(taskId) ? prev : [...prev, taskId]));
  }

  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <div className="panel-head">
          <div>
            <p className="eyebrow">{data ? longDate(data.date) : 'Loading'}</p>
            <h1 id="hero-title">
              {b ? 'Today' : loading ? 'Loading today…' : busy ? 'Preparing today…' : 'No briefing yet'}
            </h1>
          </div>
          <button type="button" onClick={() => regenerate(crypto.randomUUID())} disabled={busy || loading} aria-busy={busy}>
            {busy ? 'Preparing…' : '↻ Refresh'}
          </button>
        </div>
        {b && <p className="summary">{b.summary}</p>}
        {b && (
          <p className="status">
            <b className={`pill pill-${b.status}`}>{b.status === 'complete' ? 'Complete' : b.status === 'partial' ? 'Partial' : 'Unavailable'}</b>
            {' · '}Updated {stamp(b.generatedAt)}
            {data?.lastRun?.status === 'succeeded' && ` by ${TRIGGER_LABEL[data.lastRun.trigger] ?? 'a run'}`}
            {b.capacity.known ? ` · ${freeLabel}` : ''}
          </p>
        )}
      </section>

      <div aria-live="polite" role="status">
        {notice && <p className="notice">{notice}</p>}
        {error && <p className="warning">{error}</p>}
      </div>

      {needsSetup && conn && (
        <p className="notice">
          {conn.gmail.state !== 'connected' && conn.calendar.state !== 'connected'
            ? 'Connect Gmail and Calendar in Settings to fill this view.'
            : conn.gmail.state !== 'connected'
              ? 'Connect Gmail in Settings for the morning digest.'
              : 'Connect Calendar in Settings to show free time.'}{' '}
          <a href="/settings">Open Settings</a>
        </p>
      )}

      {(data?.warnings.length || b?.warnings.length) ? (
        <section className="warning" aria-label="Warnings">
          <ul>
            {[...(data?.warnings ?? []), ...(b?.warnings ?? [])].map((w, i) => (
              <li key={i}>⚠ {w}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {data && (digest || conn?.gmail.state === 'connected' || visibleActions.length > 0) && (
        <section className="panel" aria-labelledby="email-title">
          <div className="panel-head">
            <h2 id="email-title">This morning’s mail</h2>
            <button type="button" className="small-btn" onClick={runGmailDigest} disabled={gmailBusy || busy || loading} aria-busy={gmailBusy}>
              {gmailBusy ? 'Reading…' : 'Refresh mail'}
            </button>
          </div>
          {conn?.gmail.state !== 'connected' && !digest && (
            <p className="muted">Gmail is not connected. <a href="/settings">Connect it in Settings</a> — Deevaa never sends or marks mail read.</p>
          )}
          {digest?.status === 'unavailable' && <p className="muted">{digest.warnings[0] ?? 'Gmail could not be read. Nothing was invented.'}</p>}
          {digest && digest.status !== 'unavailable' && (
            <>
              {visibleActions.length > 0 && (
                <ul className="plain">
                  {visibleActions.map((a) => {
                    const saved = emailState.get(a.permalink);
                    return (
                      <li className="task" key={a.permalink + a.title}>
                        <div>
                          <span className="badge lane-badge lane-urgent">Time-sensitive</span>
                          <strong>
                            <a href={a.permalink} target="_blank" rel="noreferrer">
                              {a.title}
                            </a>
                          </strong>
                          <small>
                            {a.due ? `Due ${a.due}. ` : ''}
                            {a.why}
                          </small>
                          {saved?.kind === 'saved' && saved.pageUrl ? (
                            <span className="links">
                              <a href={saved.pageUrl} target="_blank" rel="noreferrer">Open in Notion</a>
                            </span>
                          ) : (
                            <div className="feedback" role="group" aria-label={`Actions for ${a.title}`}>
                              <button type="button" className="ghost" onClick={() => actOnEmail(a.permalink, 'hide')} disabled={!!emailActing}>
                                Not important
                              </button>
                              <button type="button" onClick={() => actOnEmail(a.permalink, 'save')} disabled={!!emailActing || writes !== 'granted'} aria-busy={emailActing === `save:${a.permalink}`}>
                                {emailActing === `save:${a.permalink}` ? 'Adding…' : 'Add to Notion'}
                              </button>
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {visibleSummaries.length > 0 && (
                <ul className="plain">
                  {visibleSummaries.map((s) => {
                    const saved = emailState.get(s.permalink);
                    return (
                      <li className="task" key={s.permalink + s.subject}>
                        <div>
                          <strong>
                            <a href={s.permalink} target="_blank" rel="noreferrer">
                              {s.subject}
                            </a>
                          </strong>
                          <small>
                            {s.from} — {s.why}
                          </small>
                          {saved?.kind === 'saved' && saved.pageUrl ? (
                            <span className="links">
                              <a href={saved.pageUrl} target="_blank" rel="noreferrer">Open in Notion</a>
                            </span>
                          ) : (
                            <div className="feedback" role="group" aria-label={`Actions for ${s.subject}`}>
                              <button type="button" className="ghost" onClick={() => actOnEmail(s.permalink, 'hide')} disabled={!!emailActing}>
                                Not important
                              </button>
                              <button type="button" onClick={() => actOnEmail(s.permalink, 'save')} disabled={!!emailActing || writes !== 'granted'} aria-busy={emailActing === `save:${s.permalink}`}>
                                {emailActing === `save:${s.permalink}` ? 'Adding…' : 'Add to Notion'}
                              </button>
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {visibleActions.length === 0 && visibleSummaries.length === 0 && (
                <p className="muted">Nothing time-sensitive in the last 24 hours of Primary.</p>
              )}
              {writes !== 'granted' && (visibleActions.length > 0 || visibleSummaries.length > 0) && (
                <p className="muted small">Turn on Notion updates in <a href="/settings">Settings</a> to add an email as a task.</p>
              )}
            </>
          )}
          {!digest && conn?.gmail.state === 'connected' && (
            <p className="muted">No digest yet. The 7:00 AM Pacific job will fill this, or refresh mail now.</p>
          )}
        </section>
      )}

      {b && (
        <div id="briefing">
          {(b.radar?.length ?? 0) > 0 && (
            <section className="panel radar" aria-labelledby="radar-title">
              <h2 id="radar-title">Needs attention</h2>
              <ul className="plain">
                {b.radar!
                  .filter((r) => !hiddenTaskIds.has(r.task.id))
                  .map((r) => (
                    <li key={`${r.kind}-${r.task.id}`} className={celebrateId === r.task.id ? 'done-celebrate' : undefined}>
                      <span className="badge">{RADAR_LABEL[r.kind]}</span> <strong>{r.task.title}</strong>
                      {r.task.url && <a href={r.task.url} target="_blank" rel="noreferrer">Open in Notion</a>}
                      <p className="muted">{r.detail}</p>
                      <div className="feedback" role="group" aria-label={`Mark ${r.task.title} done`}>
                        <DoneButton taskId={r.task.id} completingId={completingId} onDone={markTaskDone} />
                        <DoneToast taskId={r.task.id} celebrateId={celebrateId} />
                      </div>
                    </li>
                  ))}
              </ul>
            </section>
          )}

          {topVisible.length > 0 && (
            <section className="panel" aria-labelledby="top-title">
              <div className="panel-head">
                <h2 id="top-title">Top 3</h2>
                <a className="muted small" href="/projects">All tasks</a>
              </div>
              <ol className="outcomes">
                {topVisible.map((o) => (
                  <li key={o.task.id} className={celebrateId === o.task.id ? 'done-celebrate' : undefined}>
                    <LaneBadge lane={o.lane} /> <strong>{o.task.title}</strong>
                    {whyOpen === o.task.id && <p className="muted">{o.reasons.join(' · ') || 'Ready in Notion'}</p>}
                    {whyOpen !== o.task.id && <p className="muted">Next: {o.nextAction}</p>}
                    <TaskLinks task={o.task} />
                    <div className="feedback" role="group" aria-label={`Feedback for ${o.task.title}`}>
                      <button type="button" className="ghost" onClick={() => setWhyOpen(whyOpen === o.task.id ? null : o.task.id)} aria-expanded={whyOpen === o.task.id}>
                        Why this?
                      </button>
                      <button type="button" className="ghost" onClick={() => sendFeedback(o.task.id, 'not_now')} disabled={!!completingId}>
                        Not now
                      </button>
                      <DoneButton taskId={o.task.id} completingId={completingId} onDone={markTaskDone} />
                      <button type="button" className="ghost" onClick={() => skipTop(o.task.id)} disabled={!!completingId}>
                        Choose another
                      </button>
                      <DoneToast taskId={o.task.id} celebrateId={celebrateId} />
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <div className="columns">
            <section className="panel" aria-labelledby="blocks-title">
              <h2 id="blocks-title">Today’s blocks</h2>
              <ul className="plain">
                {b.blocks.map((x) => (
                  <BlockRow
                    key={x.label}
                    block={x}
                    completingId={completingId}
                    celebrateId={celebrateId}
                    hiddenTaskIds={hiddenTaskIds}
                    onDone={markTaskDone}
                  />
                ))}
              </ul>
            </section>

            <section className="panel" aria-labelledby="next-title">
              <div className="panel-head">
                <h2 id="next-title">Next action</h2>
                <a className="muted small" href="/calendar">Calendar</a>
              </div>
              <p className="muted">{b.capacity.known ? `${freeLabel} between 7:00 AM and 10:30 PM.` : 'Calendar not available, so free time is unknown.'}</p>
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
                {action?.kind === 'task' && !hiddenTaskIds.has(action.task.id) && (
                  <div className="selected">
                    <b>{action.task.title}</b>
                    <p>{action.reason}</p>
                    <p>{action.doneDefinition}</p>
                    <TaskLinks task={action.task} />
                    <div className="feedback" role="group" aria-label="How did this recommendation work?">
                      {FEEDBACK_BUTTONS.map((f) =>
                        f.kind === 'done' ? (
                          <DoneButton key={f.kind} taskId={action.task.id} completingId={completingId} onDone={markTaskDone} />
                        ) : (
                          <button key={f.kind} type="button" className="ghost" onClick={() => sendFeedback(action.task.id, f.kind)} disabled={!!completingId}>
                            {f.label}
                          </button>
                        )
                      )}
                      <DoneToast taskId={action.task.id} celebrateId={celebrateId} />
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
              <ul className="plain">
                {b.waiting!
                  .filter((t) => !hiddenTaskIds.has(t.id))
                  .map((t) => (
                    <li key={t.id} className={`task${celebrateId === t.id ? ' done-celebrate' : ''}`}>
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
        </div>
      )}
    </>
  );
}
