'use client';

import {useCallback, useEffect, useState} from 'react';
import {BLUEPRINT_FIELDS, type Blueprint, type BlueprintField} from '@/lib/blueprint';

type View = {version: number; updatedAt: string | null; data: Blueprint; suggestions: {id: string; kind: string; text: string; createdAt: string}[]};

const KIND_LABEL: Record<string, string> = {
  goal: 'Goal',
  preference: 'Preference',
  personal_context: 'Personal context',
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

  const load = useCallback(async () => {
    const res = await fetch('/api/blueprint', {cache: 'no-store'});
    if (!res.ok) return;
    const body: View = await res.json();
    setView(body);
    setDraft(toText(body.data));
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
    setMessage(`Saved as version ${body.version}. The briefing is being refreshed with it.`);
    onSaved();
  }

  async function review(id: string, action: 'confirm' | 'dismiss') {
    const res = await fetch('/api/blueprint', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id, action})});
    const body = await res.json().catch(() => null);
    if (!res.ok) return setMessage(body?.error?.message ?? 'Could not update that note.');
    setView(body);
    setDraft(toText(body.data));
    if (action === 'confirm') onSaved();
  }

  if (!view || !draft) return null;
  const filled = BLUEPRINT_FIELDS.filter((f) => view.data[f.key].length).length;

  return (
    <section className="panel blueprint" aria-labelledby="blueprint-title">
      <h2 id="blueprint-title">Life Blueprint</h2>
      <p className="muted">
        Only what you confirm here shapes your priorities. Deevaa never fills it in by itself.{' '}
        {view.version ? `Version ${view.version}, ${filled} section(s) filled.` : 'Empty for now.'}
      </p>

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
                    <button type="button" className="small-btn" onClick={() => review(s.id, 'confirm')}>
                      Confirm
                    </button>
                    <button type="button" className="ghost small-btn" onClick={() => review(s.id, 'dismiss')}>
                      Dismiss
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <details>
        <summary>Edit or import your Blueprint</summary>
        <p className="muted small">One item per line. To import an existing plan once, paste it into the matching sections, review it, then save.</p>
        {BLUEPRINT_FIELDS.map((f) => (
          <label key={f.key}>
            {f.label} <span className="muted">· {f.hint}</span>
            <textarea rows={2} value={draft[f.key]} onChange={(e) => setDraft({...draft, [f.key]: e.target.value})} />
          </label>
        ))}
        <button type="button" className="cta" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save Blueprint'}
        </button>
      </details>
      {message && <p className="muted" role="status">{message}</p>}
    </section>
  );
}
