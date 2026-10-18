import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {runSpecialist} from '@/lib/agents/specialists';
import {fetchNotionTasks} from '@/lib/notion';
import {AGENT_CATALOG, ensureAgentDefinitions, listAgentRuns} from '@/lib/runtime/store';
import {getSessionUser} from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const definitions = await ensureAgentDefinitions();
  const runs = await listAgentRuns(user.id);
  return privateJson({
    agents: definitions.map((agent) => ({
      id: agent.id,
      title: agent.title,
      mission: agent.mission,
      scopes: agent.scopes,
      memoryPartition: agent.memoryPartition,
      nextRun: AGENT_CATALOG.find((item) => item.id === agent.id)?.id === 'gmail.morning' ? '07:00 America/Los_Angeles' : 'manual',
      lastRun: runs.find((run) => run.agentId === agent.id) ?? null
    }))
  });
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => null)) as {agentId?: unknown} | null;
  const agentId = typeof body?.agentId === 'string' ? body.agentId : '';
  if (!agentId || agentId === 'gmail.morning') return apiError(400, 'bad_agent', 'Choose a specialist. The Gmail digest stays on its schedule.');
  const read = await fetchNotionTasks().catch(() => null);
  const tasks = read && read.health.state === 'connected' ? read.tasks : [];
  const result = await runSpecialist(user.id, agentId, new Date(), tasks);
  return privateJson(result);
}
