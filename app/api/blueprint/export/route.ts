import {emptyBlueprint, parseBlueprint} from '@/lib/blueprint';
import {privateJson, unauthorized} from '@/lib/http';
import {listImportHistory} from '@/lib/import-store';
import {latestBlueprint} from '@/lib/intake-store';
import {getSessionUser} from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Blueprint data and import metadata only — never the raw seed file. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const row = await latestBlueprint(user.id);
  const imports = await listImportHistory(user.id, 20);
  return privateJson({
    version: row?.version ?? 0,
    updatedAt: row?.createdAt.toISOString() ?? null,
    data: row ? parseBlueprint(row.data) : emptyBlueprint(),
    imports: imports.map((i) => ({
      id: i.id,
      sourceName: i.sourceName,
      contentSha256: i.contentSha256,
      previewSha256: i.previewSha256,
      status: i.status,
      createdAt: i.createdAt.toISOString(),
      appliedAt: i.appliedAt?.toISOString() ?? null
    }))
  });
}
