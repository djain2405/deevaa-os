'use client';

import {useCallback, useEffect, useState} from 'react';
import {BLUEPRINT_FIELDS, type Blueprint, type BlueprintField} from '@/lib/blueprint';
import type {ImportPreview, ImportTask} from '@/lib/blueprint-import';

type BlueprintNotion = {status: 'published' | 'skipped' | 'failed'; url: string | null; message: string};

type View = {
  version: number;
  updatedAt: string | null;
  data: Blueprint;
  suggestions: {id: string; kind: string; text: string; createdAt: string}[];
  notionPageUrl: string | null;
  restoredFromNotion?: boolean;
  restoreMessage?: string | null;
  notion?: BlueprintNotion;
};

type PreviewResponse = {
  id: string;
  previewSha256: string;
  preview: ImportPreview;
  previouslyApplied?: boolean;
  note?: string | null;
};

const KIND_LABEL: Record<string, string> = {
  goal: 'Goal',
  preference: 'Preference',
  personal_context: 'Personal context',
  boundary: 'Boundary',
  reflection: 'Lesson',
  capacity: 'Energy and capacity',
  project: 'Active project',
  constraint: 'Scheduling constraint'
};

const toText = (data: Blueprint) => Object.fromEntries(BLUEPRINT_FIELDS.map((f) => [f.key, data[f.key].join('\n')])) as Record<BlueprintField, string>;

export function BlueprintPanel({onSaved}: {onSaved: () => void}) {
  const [view, setView] = useState<View | null>(null);
  const [draft, setDraft] = useState<Record<BlueprintField, string> | null>(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [pasteMd, setPasteMd] = useState('');
  const [importPreview, setImportPreview] = useState<PreviewResponse | null>(null);
  const [importTasks, setImportTasks] = useState<ImportTask[]>([]);
  const [importBusy, setImportBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    setLoadError('');
    const res = await fetch('/api/blueprint', {cache: 'no-store'});
    if (res.status === 401) {
      window.location.href = '/login';
      return;
    }
    if (!res.ok) {
      setLoadError('Could not load your Life Blueprint. Try refreshing the page.');
      return;
    }
    const body = (await res.json().catch(() => null)) as View | null;
    if (!body) {
      setLoadError('Could not load your Life Blueprint. Try refreshing the page.');
      return;
    }
    setView(body);
    setDraft(toText(body.data));
    const hasContent = BLUEPRINT_FIELDS.some((f) => body.data[f.key].length > 0);
    setEditing(!hasContent);
    if (body.restoredFromNotion && hasContent) {
      setMessage('Loaded your Life Blueprint from Notion.');
    } else if (!hasContent && body.restoreMessage) {
      setMessage(body.restoreMessage);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!view || !draft) return;
    setSaving(true);
    const data = Object.fromEntries(
      BLUEPRINT_FIELDS.map((f) => [f.key, draft[f.key].split('\n').map((l) => l.trim()).filter(Boolean)])
    ) as Blueprint;
    const res = await fetch('/api/blueprint', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({version: view.version, data})});
    const body = await res.json().catch(() => null);
    setSaving(false);
    if (!res.ok) return setMessage(body?.error?.message ?? 'Could not save.');
    setView(body);
    setDraft(toText(body.data));
    const notionNote = body.notion?.message ? ` ${body.notion.message}` : '';
    setMessage(`Blueprint saved as version ${body.version}. (Each save increases the version number; that is normal.) The briefing is refreshing.${notionNote}`);
    setEditing(false);
    onSaved();
  }

  function cancelEdit() {
    if (!view) return;
    setDraft(toText(view.data));
    setEditing(false);
    setMessage('');
  }

  async function review(id: string, action: 'confirm' | 'dismiss') {
    const res = await fetch('/api/blueprint', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id, action})});
    const body = await res.json().catch(() => null);
    if (!res.ok) return setMessage(body?.error?.message ?? 'Could not update that note.');
    setView(body);
    setDraft(toText(body.data));
    if (action === 'confirm') onSaved();
  }

  async function buildPreview() {
    if (!pasteMd.trim()) return setMessage('Paste your Life Blueprint markdown first.');
    setImportBusy(true);
    setMessage('');
    const res = await fetch('/api/blueprint/import', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({sourceName: 'life-blueprint-import.md', markdown: pasteMd})});
    const body = await res.json().catch(() => null);
    setImportBusy(false);
    if (!res.ok) return setMessage(body?.error?.message ?? 'Could not build a preview.');
    setImportPreview(body as PreviewResponse);
    setImportTasks(body.preview.tasks);
    const again = body.previouslyApplied ? ' You already approved this file once; approving again updates matching Notion tasks.' : '';
    setMessage(
      (body.note as string) ||
        `Preview ready: ${body.preview.counts.blueprintFields} Blueprint sections, ${body.preview.tasks.length} Notion items. Scroll down to review, then Approve import.${again}`
    );
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setPasteMd(text);
    e.target.value = '';
  }

  async function approveImport() {
    if (!importPreview) return;
    setImportBusy(true);
    const res = await fetch('/api/blueprint/import/apply', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({id: importPreview.id, previewSha256: importPreview.previewSha256, tasks: importTasks})
    });
    const body = await res.json().catch(() => null);
    setImportBusy(false);
    if (!res.ok) return setMessage(body?.error?.message ?? 'Import could not be applied.');
    setImportPreview(null);
    setPasteMd('');
    const notionNote = body.notion?.message ? ` ${body.notion.message}` : '';
    setMessage((body.message ?? 'Import applied.') + notionNote);
    await load();
    onSaved();
  }

  async function cancelImport() {
    if (!importPreview) return;
    await fetch('/api/blueprint/import/cancel', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: importPreview.id})});
    setImportPreview(null);
    setMessage('Import canceled. Nothing was written.');
  }

  if (!view || !draft) {
    return (
      <section className="panel blueprint" aria-labelledby="blueprint-title">
        <h2 id="blueprint-title">Life Blueprint</h2>
        <p className="muted">{loadError || 'Loading your Blueprint…'}</p>
      </section>
    );
  }
  const filled = BLUEPRINT_FIELDS.filter((f) => view.data[f.key].length).length;
  const pv = importPreview?.preview;

  return (
    <section className="panel blueprint" aria-labelledby="blueprint-title">
      <h2 id="blueprint-title">Life Blueprint</h2>
      <p className="muted">
        This is the Life Blueprint Deevaa uses for ranking. Notion keeps your tasks, and a copy of this page if you have published it.{' '}
        {view.version ? `Version ${view.version} · ${filled} section${filled === 1 ? '' : 's'} filled.` : 'Empty for now.'}
        {view.notionPageUrl && (
          <>
            {' '}
            <a href={view.notionPageUrl} target="_blank" rel="noopener noreferrer">Open in Notion</a>
          </>
        )}
      </p>

      {message && <p className="notice" role="status">{message}</p>}

      {!editing && filled > 0 && (
        <div className="blueprint-read" aria-label="Your Life Blueprint">
          <div className="panel-head">
            <span className="muted small">Read-only view — used for ranking and briefings.</span>
            <button type="button" className="small-btn" onClick={() => setEditing(true)}>Edit Blueprint</button>
          </div>
          <ul className="plain blueprint-sections">
            {BLUEPRINT_FIELDS.filter((f) => view.data[f.key].length).map((f) => (
              <li key={f.key} className="blueprint-section">
                <h3 className="blueprint-section-title">{f.label}</h3>
                <ul className="blueprint-lines">
                  {view.data[f.key].map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!editing && filled === 0 && (
        <p className="muted">
          No sections yet.{' '}
          {view.restoreMessage ? view.restoreMessage + ' ' : ''}
          <button type="button" className="small-btn" onClick={() => setEditing(true)}>Add Blueprint</button>
          {' '}or import from markdown below.
        </p>
      )}

      {editing && (
        <div className="blueprint-edit" aria-label="Edit Life Blueprint">
          <div className="panel-head">
            <span className="muted small">One line per bullet when you save.</span>
            {filled > 0 && (
              <button type="button" className="ghost small-btn" onClick={cancelEdit}>Cancel</button>
            )}
          </div>
          {BLUEPRINT_FIELDS.map((f) => (
            <label key={f.key}>
              {f.label} <span className="muted">· {f.hint}</span>
              <textarea rows={3} value={draft[f.key]} onChange={(e) => setDraft({...draft, [f.key]: e.target.value})} />
            </label>
          ))}
          <button type="button" className="cta" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Blueprint'}</button>
        </div>
      )}

      <details className="blueprint-import-details">
        <summary>Import Life Blueprint from markdown (one time)</summary>
        <div className="import-block">
          <p className="muted small">Paste or upload your markdown export. Deevaa maps it into Blueprint sections and Notion tasks. You approve before anything is saved.</p>
          <textarea className="import-paste" rows={4} placeholder="Paste life-blueprint-import.md contents…" value={pasteMd} onChange={(e) => setPasteMd(e.target.value)} />
          <div className="row-actions">
            <label className="ghost small-btn">
              Upload .md
              <input type="file" accept=".md,text/markdown,text/plain" hidden onChange={onFile} />
            </label>
            <button type="button" onClick={buildPreview} disabled={importBusy}>
              {importBusy ? 'Working…' : 'Preview import'}
            </button>
          </div>
        </div>
      </details>

      {pv && (
        <div className="import-preview" role="region" aria-label="Import preview">
          <h3 className="small">Review before saving</h3>
          <p className="muted small">
            Blueprint: {pv.counts.blueprintFields} sections · Active {pv.counts.active} · Waiting {pv.counts.waiting} · Done {pv.counts.done} · Ideas {pv.counts.ideas}
          </p>
          <details open>
            <summary>Blueprint changes by section</summary>
            <ul className="plain notes">
              {BLUEPRINT_FIELDS.filter((f) => pv.blueprint[f.key].length).map((f) => (
                <li key={f.key}>
                  <strong>{f.label}</strong>
                  <ul>
                    {pv.blueprint[f.key].map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </details>
          <details>
            <summary>Notion tasks ({importTasks.length})</summary>
            <ul className="plain">
              {importTasks.map((t) => (
                <li key={t.id} className="intake-item">
                  <span className="badge">{t.bucket}</span>
                  <label>
                    Title
                    <input value={t.title} onChange={(e) => setImportTasks(importTasks.map((x) => (x.id === t.id ? {...x, title: e.target.value} : x)))} />
                  </label>
                  <span className="muted">{t.status}{t.project ? ` · ${t.project}` : ''}{t.due ? ` · due ${t.due}` : ''}</span>
                </li>
              ))}
            </ul>
          </details>
          {pv.skipped.length > 0 && (
            <details>
              <summary>Skipped ({pv.skipped.length})</summary>
              <ul className="plain notes">{pv.skipped.map((s) => <li key={s.text}>{s.reason}: {s.text}</li>)}</ul>
            </details>
          )}
          {pv.uncertain.length > 0 && (
            <details>
              <summary>Uncertain ({pv.uncertain.length})</summary>
              <ul className="plain notes">{pv.uncertain.map((u) => <li key={u.text}>{u.reason}</li>)}</ul>
            </details>
          )}
          <div className="row-actions">
            <button type="button" className="cta" onClick={approveImport} disabled={importBusy}>Approve import</button>
            <button type="button" className="ghost" onClick={cancelImport} disabled={importBusy}>Cancel</button>
          </div>
        </div>
      )}

      {view.suggestions.length > 0 && (
        <>
          <h3 className="small">From your chats, waiting for review ({view.suggestions.length})</h3>
          <ul className="plain notes">
            {view.suggestions.map((s) => (
              <li key={s.id} className="intake-item">
                <span className="badge badge-pending">{KIND_LABEL[s.kind] ?? s.kind}</span>
                <div>
                  <strong>{s.text}</strong>
                  <div className="row-actions">
                    <button type="button" className="small-btn" onClick={() => review(s.id, 'confirm')}>Confirm</button>
                    <button type="button" className="ghost small-btn" onClick={() => review(s.id, 'dismiss')}>Dismiss</button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

    </section>
  );
}
