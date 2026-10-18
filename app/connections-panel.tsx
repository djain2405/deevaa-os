'use client';

import {useCallback, useEffect, useState} from 'react';
import type {Connections} from '@/lib/briefing-view';
import type {SourceHealth} from '@/lib/types';

type BriefingPayload = {
  briefing: {sources?: {notion?: SourceHealth; calendar?: SourceHealth}; ai?: {detail?: string}} | null;
  connections: Connections;
};

const stamp = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles'});

function StateBadge({state}: {state: 'connected' | 'not_connected' | 'error' | 'pending'}) {
  const label = {connected: 'Connected', not_connected: 'Not connected', error: 'Error', pending: 'Configured, not read yet'}[state];
  return <span className={`badge badge-${state}`}>{label}</span>;
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

export function ConnectionsPanel() {
  const [payload, setPayload] = useState<BriefingPayload | null>(null);
  const [writes, setWrites] = useState<'granted' | 'off' | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/briefing', {cache: 'no-store'});
    if (res.status === 401) return void (window.location.href = '/login');
    const body = await res.json().catch(() => null);
    if (!res.ok) return setError(body?.error?.message ?? 'Could not load connections.');
    setPayload(body);
    setError('');
  }, []);

  const loadWrites = useCallback(async () => {
    const res = await fetch('/api/permissions', {cache: 'no-store'});
    if (!res.ok) return;
    const body = await res.json();
    setWrites(body.permissions.notion_task_write.status === 'granted' ? 'granted' : 'off');
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void load();
      void loadWrites();
    }, 0);
    return () => clearTimeout(timer);
  }, [load, loadWrites]);

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

  async function disconnectCalendar() {
    if (!window.confirm('Disconnect Google Calendar? Deevaa will forget its read-only access.')) return;
    const res = await fetch('/api/google/disconnect', {method: 'POST'});
    setNotice(res.ok ? 'Google Calendar disconnected.' : 'Could not disconnect Google Calendar.');
    await load();
  }

  async function disconnectGmail() {
    if (!window.confirm('Disconnect Gmail? Deevaa will forget its read-only access and will not send or change any mail.')) return;
    const res = await fetch('/api/google/gmail/disconnect', {method: 'POST'});
    setNotice(res.ok ? 'Gmail disconnected.' : 'Could not disconnect Gmail.');
    await load();
  }

  const conn = payload?.connections;
  const b = payload?.briefing;
  const calendarFallback = conn?.calendar.state === 'revoked' ? 'error' : conn?.calendar.state === 'connected' ? 'pending' : 'not_connected';
  const gmailFallback = conn?.gmail.state === 'revoked' ? 'error' : conn?.gmail.state === 'connected' ? 'pending' : 'not_connected';

  return (
    <section className="panel" aria-labelledby="connections-title">
      <h2 id="connections-title">Connections</h2>
      <p className="muted">Gmail and Calendar stay read-only. Notion writes only happen when you turn them on.</p>
      {error && <p className="warning">{error}</p>}
      {notice && <p className="notice">{notice}</p>}
      {!conn && !error && <p className="muted">Loading connections…</p>}
      {conn && (
        <ul className="conns">
          <SourceRow name="Notion tasks" health={b?.sources?.notion} fallback={conn.notion === 'configured' ? 'pending' : 'not_connected'}>
            {conn.notion === 'not_configured' && <p className="muted small">Set NOTION_TOKEN and NOTION_DATA_SOURCE_ID on the server.</p>}
            {conn.notion === 'configured' && writes && (
              <div className="row-actions">
                <span className="muted small">Notion task updates and Life Blueprint publish: {writes === 'granted' ? 'On' : 'Off'}</span>
                <button type="button" className={writes === 'granted' ? 'ghost' : ''} onClick={toggleWrites} aria-pressed={writes === 'granted'}>
                  {writes === 'granted' ? 'Turn off' : 'Turn on'}
                </button>
              </div>
            )}
          </SourceRow>
          <SourceRow name="Google Calendar (read-only)" health={b && conn.calendar.state !== 'not_connected' ? b.sources?.calendar : undefined} fallback={calendarFallback}>
            {conn.calendar.state === 'connected' ? (
              <div className="row-actions">
                <span className="muted small">{conn.calendar.calendarCount} calendar(s)</span>
                <button type="button" className="ghost" onClick={disconnectCalendar}>Disconnect</button>
              </div>
            ) : (
              <form method="post" action="/api/google/connect">
                <p className="muted small">Connect once on this site. Calendar access from your laptop does not carry over.</p>
                <button type="submit">{conn.calendar.state === 'revoked' ? 'Reconnect' : 'Connect'} Google Calendar</button>
              </form>
            )}
          </SourceRow>
          <SourceRow name="Gmail (read-only)" fallback={gmailFallback}>
            {conn.gmail.state === 'connected' ? (
              <div className="row-actions">
                <span className="muted small">Inbox scanned for the morning digest only</span>
                <button type="button" className="ghost" onClick={disconnectGmail}>Disconnect</button>
              </div>
            ) : (
              <form method="post" action="/api/google/gmail/connect">
                <p className="muted small">Read-only. Deevaa never sends, labels, or marks mail read.</p>
                <button type="submit">{conn.gmail.state === 'revoked' ? 'Reconnect' : 'Connect'} Gmail (read-only)</button>
              </form>
            )}
          </SourceRow>
          <li className="conn">
            <div>
              <strong>AI explanations</strong> <span className={`badge badge-${conn.ai === 'enabled' ? 'connected' : 'not_connected'}`}>{conn.ai === 'enabled' ? 'On' : 'Off'}</span>
              <p className="muted">{b?.ai?.detail ?? (conn.ai === 'enabled' ? 'Optional wording on top of the deterministic plan.' : 'Plans are deterministic; set OPENAI_API_KEY for optional explanations.')}</p>
            </div>
          </li>
          <li className="conn">
            <div>
              <strong>Database</strong>{' '}
              <span className={`badge badge-${conn.store === 'postgres' ? 'connected' : 'pending'}`}>
                {conn.store === 'postgres' ? 'Connected' : 'Not connected'}
              </span>
              <p className="muted">
                {conn.store === 'postgres'
                  ? 'This site is using Railway Postgres, so sign-in, briefings, and Blueprint stay after redeploys.'
                  : 'This site is not using Railway Postgres yet. In Railway, open the web service → Variables and add DATABASE_URL as a reference to your Postgres plugin, then redeploy.'}
              </p>
            </div>
          </li>
          <li className="conn">
            <div>
              <strong>Scheduled briefing</strong>{' '}
              <span className={`badge badge-${conn.scheduler.lastStatus === 'succeeded' ? 'connected' : conn.scheduler.lastStatus === 'failed' ? 'error' : 'not_connected'}`}>
                {conn.scheduler.lastRunAt ? (conn.scheduler.lastStatus === 'succeeded' ? 'Last run succeeded' : `Last run ${conn.scheduler.lastStatus}`) : 'No run recorded'}
              </span>
              <p className="muted">
                {conn.scheduler.lastRunAt
                  ? `A scheduler called Deevaa at ${stamp(conn.scheduler.lastRunAt)}.`
                  : 'Nothing has triggered a nightly briefing yet. Scheduling is only active once the app is deployed and a cron call has succeeded.'}
              </p>
            </div>
          </li>
        </ul>
      )}
    </section>
  );
}
