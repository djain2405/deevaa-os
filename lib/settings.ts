import {and, eq} from 'drizzle-orm';
import {DateTime} from 'luxon';
import {getDb} from './db/client';
import {lifeAreas, userSettings} from './db/schema';

export const DEFAULT_LIFE_AREAS: {slug: string; name: string; visibility: 'work' | 'private'}[] = [
  {slug: 'career', name: 'Career / work', visibility: 'work'},
  {slug: 'android-gde', name: 'Android GDE', visibility: 'work'},
  {slug: 'open-source', name: 'Open source', visibility: 'work'},
  {slug: 'consultancy', name: 'Consultancy / finance', visibility: 'work'},
  {slug: 'immigration', name: 'Immigration / EB-1A', visibility: 'private'},
  {slug: 'family', name: 'Family / relationships', visibility: 'private'},
  {slug: 'health', name: 'Health', visibility: 'private'},
  {slug: 'home', name: 'Home', visibility: 'private'},
  {slug: 'travel', name: 'Travel', visibility: 'private'},
  {slug: 'growth', name: 'Personal growth', visibility: 'private'},
  {slug: 'creative', name: 'Fun / creative projects', visibility: 'private'}
];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function ensureLifeAreas(userId: string) {
  const db = await getDb();
  await db
    .insert(lifeAreas)
    .values(DEFAULT_LIFE_AREAS.map((area, sortOrder) => ({userId, ...area, sortOrder})))
    .onConflictDoNothing({target: [lifeAreas.userId, lifeAreas.slug]});
  return db.select().from(lifeAreas).where(eq(lifeAreas.userId, userId));
}

export async function listLifeAreas(userId: string) {
  return ensureLifeAreas(userId);
}

export async function updateLifeArea(userId: string, slug: string, patch: {name?: string; visibility?: 'work' | 'private'; archived?: boolean}) {
  const db = await getDb();
  await ensureLifeAreas(userId);
  const [row] = await db
    .update(lifeAreas)
    .set({
      ...(patch.name ? {name: patch.name.slice(0, 80)} : {}),
      ...(patch.visibility ? {visibility: patch.visibility} : {}),
      ...(typeof patch.archived === 'boolean' ? {archived: patch.archived} : {})
    })
    .where(and(eq(lifeAreas.userId, userId), eq(lifeAreas.slug, slug)))
    .returning();
  return row ?? null;
}

export async function getSettings(userId: string) {
  const db = await getDb();
  await db.insert(userSettings).values({userId, agentBudgets: {'gmail.morning': 20000}}).onConflictDoNothing({target: userSettings.userId});
  const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, userId));
  await ensureLifeAreas(userId);
  return row;
}

export type SettingsPatch = {
  timezone?: string;
  quietStart?: string;
  quietEnd?: string;
  pauseAll?: boolean;
  maintenanceMode?: boolean;
  lifeAreaVisibility?: Record<string, 'visible' | 'private'>;
  agentBudgets?: Record<string, number>;
  featureFlags?: Record<string, boolean>;
};

export function settingsPatchError(patch: SettingsPatch) {
  if (patch.timezone && !/^[A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(patch.timezone)) return 'Timezone must be an IANA name.';
  if (patch.quietStart && !HHMM.test(patch.quietStart)) return 'Quiet hours use HH:MM.';
  if (patch.quietEnd && !HHMM.test(patch.quietEnd)) return 'Quiet hours use HH:MM.';
  if (patch.agentBudgets && Object.values(patch.agentBudgets).some((n) => !Number.isInteger(n) || n < 0 || n > 200000)) return 'Agent budgets are whole token counts.';
  return null;
}

export async function updateSettings(userId: string, patch: SettingsPatch) {
  const db = await getDb();
  await getSettings(userId);
  const [row] = await db
    .update(userSettings)
    .set({...patch, updatedAt: new Date()})
    .where(eq(userSettings.userId, userId))
    .returning();
  return row;
}

export function inQuietHours(settings: {timezone: string; quietStart: string; quietEnd: string}, now: Date) {
  const local = DateTime.fromJSDate(now).setZone(settings.timezone);
  if (!local.isValid) return false;
  const minutes = local.hour * 60 + local.minute;
  const [sh, sm] = settings.quietStart.split(':').map(Number);
  const [eh, em] = settings.quietEnd.split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}
