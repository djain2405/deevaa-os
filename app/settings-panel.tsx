'use client';

import {useCallback, useEffect, useState} from 'react';

type Settings = {
  timezone: string;
  quietStart: string;
  quietEnd: string;
  pauseAll: boolean;
  maintenanceMode: boolean;
  agentBudgets: Record<string, number>;
};

export function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/settings', {cache: 'no-store'});
    const body = await res.json().catch(() => null);
    if (!res.ok) return setError(body?.error?.message ?? 'Settings could not be loaded.');
    setSettings(body);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function save(patch: Partial<Settings>) {
    setError('');
    const res = await fetch('/api/settings', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(patch)});
    const body = await res.json().catch(() => null);
    if (!res.ok) return setError(body?.error?.message ?? 'Settings were not saved.');
    setMessage('Saved.');
    await load();
  }

  async function exportData() {
    const res = await fetch('/api/account', {cache: 'no-store'});
    const body = await res.json().catch(() => null);
    if (!res.ok) return setError(body?.error?.message ?? 'Export failed.');
    const blob = new Blob([JSON.stringify(body, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'deevaa-export.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function remove() {
    const confirmed = window.confirm('Delete Deevaa data on this account? Notion pages stay.');
    if (!confirmed) return;
    const res = await fetch('/api/account', {method: 'DELETE', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({confirm: 'delete-my-data'})});
    const body = await res.json().catch(() => null);
    if (!res.ok) return setError(body?.error?.message ?? 'Delete failed.');
    window.location.href = '/login';
  }

  if (!settings) return <p className="muted">{error || 'Loading settings…'}</p>;
  return (
    <section className="panel" aria-labelledby="settings-title">
      <h2 id="settings-title">Settings and governance</h2>
      {error && <p className="warning">{error}</p>}
      {message && <p className="notice">{message}</p>}
      <p className="muted">Timezone {settings.timezone}. Quiet hours {settings.quietStart}–{settings.quietEnd}. Gmail still runs at 7:00 only when agents are not paused.</p>
      <div className="row-actions">
        <button type="button" onClick={() => save({pauseAll: !settings.pauseAll})}>{settings.pauseAll ? 'Resume agents' : 'Pause all agents'}</button>
        <button type="button" className="ghost" onClick={() => save({maintenanceMode: !settings.maintenanceMode})}>
          {settings.maintenanceMode ? 'Leave maintenance' : 'Maintenance mode'}
        </button>
        <button type="button" className="ghost" onClick={exportData}>Export my data</button>
        <button type="button" className="ghost" onClick={remove}>Delete Deevaa data</button>
      </div>
    </section>
  );
}
