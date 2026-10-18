import {canonicalStatus} from '@/lib/canonical-status';
import {privateJson, unauthorized} from '@/lib/http';
import {fetchNotionTasks} from '@/lib/notion';
import {reconciliationPreview} from '@/lib/reconcile';
import {getSessionUser} from '@/lib/session';
import {localDate} from '@/lib/time';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const today = localDate(new Date());
  const read = await fetchNotionTasks();
  if (read.health.state !== 'connected') return privateJson({today, health: read.health, tasks: [], preview: []});
  const tasks = read.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    notionStatus: task.status,
    canonical: canonicalStatus(task, today),
    due: task.due,
    project: task.project,
    url: task.url,
    nextAction: task.nextAction
  }));
  return privateJson({today, health: read.health, tasks, preview: reconciliationPreview(read.tasks, [], today)});
}
