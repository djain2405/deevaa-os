import {forbiddenOrigin, isSameOrigin, privateJson, unauthorized, apiError} from '@/lib/http';
import {getSessionUser} from '@/lib/session';
import {audit} from '@/lib/store';
import {getSettings, settingsPatchError, updateSettings, type SettingsPatch} from '@/lib/settings';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const settings = await getSettings(user.id);
  return privateJson({
    timezone: settings.timezone,
    quietStart: settings.quietStart,
    quietEnd: settings.quietEnd,
    pauseAll: settings.pauseAll,
    maintenanceMode: settings.maintenanceMode,
    lifeAreaVisibility: settings.lifeAreaVisibility,
    agentBudgets: settings.agentBudgets,
    featureFlags: settings.featureFlags
  });
}

export async function PUT(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => null)) as SettingsPatch | null;
  if (!body || typeof body !== 'object') return apiError(400, 'bad_body', 'Send a settings object.');
  const patch: SettingsPatch = {};
  if (typeof body.timezone === 'string') patch.timezone = body.timezone;
  if (typeof body.quietStart === 'string') patch.quietStart = body.quietStart;
  if (typeof body.quietEnd === 'string') patch.quietEnd = body.quietEnd;
  if (typeof body.pauseAll === 'boolean') patch.pauseAll = body.pauseAll;
  if (typeof body.maintenanceMode === 'boolean') patch.maintenanceMode = body.maintenanceMode;
  if (body.lifeAreaVisibility && typeof body.lifeAreaVisibility === 'object') patch.lifeAreaVisibility = body.lifeAreaVisibility;
  if (body.agentBudgets && typeof body.agentBudgets === 'object') patch.agentBudgets = body.agentBudgets;
  if (body.featureFlags && typeof body.featureFlags === 'object') patch.featureFlags = body.featureFlags;
  const problem = settingsPatchError(patch);
  if (problem) return apiError(400, 'bad_settings', problem);
  const settings = await updateSettings(user.id, patch);
  await audit(user.id, 'settings.update', 'ok', {pauseAll: settings.pauseAll, maintenanceMode: settings.maintenanceMode});
  return privateJson({ok: true, pauseAll: settings.pauseAll, maintenanceMode: settings.maintenanceMode, timezone: settings.timezone});
}
