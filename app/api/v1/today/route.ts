import {getBriefing} from '@/lib/store';
import {privateJson, unauthorized} from '@/lib/http';
import {getSessionUser} from '@/lib/session';
import {localDate} from '@/lib/time';
import {BRIEFING_VERSION, type BriefingSnapshot} from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Session-authenticated read API for a future mobile client. It uses the stored briefing, not a second planner. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const date = localDate(new Date());
  const row = await getBriefing(user.id, date, BRIEFING_VERSION);
  const snapshot = row?.snapshot as BriefingSnapshot | undefined;
  return privateJson({
    date,
    summary: snapshot?.summary ?? null,
    topOutcomes: (snapshot?.topOutcomes ?? []).map((item) => item.task.title),
    blocks: (snapshot?.blocks ?? []).map((block) => ({
      label: block.label,
      role: block.role ?? null,
      state: block.state,
      nextAction: block.nextAction ?? null,
      expectedOutcome: block.expectedOutcome ?? null,
      provenance: block.provenance ?? null,
      whyNow: block.whyNow ?? null,
      emptyDetail: block.emptyDetail ?? null
    }))
  });
}
