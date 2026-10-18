import {healthPayload} from '@/lib/health';
import {storeKind} from '@/lib/db/client';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(healthPayload(storeKind()), {headers: {'Cache-Control': 'no-store'}});
}
