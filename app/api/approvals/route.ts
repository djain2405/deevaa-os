import {apiError, forbiddenOrigin, isSameOrigin, privateJson, unauthorized} from '@/lib/http';
import {getSessionUser} from '@/lib/session';
import {audit} from '@/lib/store';
import {decideApproval, resumeAfterApproval} from '@/lib/runtime/worker';
import {listApprovals} from '@/lib/runtime/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const rows = await listApprovals(user.id);
  return privateJson({
    approvals: rows.map((row) => ({
      id: row.id,
      action: row.action,
      risk: row.risk,
      status: row.status,
      payload: row.payload,
      payloadHash: row.payloadHash,
      evidence: row.evidence,
      expiresAt: row.expiresAt.toISOString(),
      executionResult: row.executionResult
    }))
  });
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return forbiddenOrigin();
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => null)) as {id?: unknown; status?: unknown; payload?: unknown} | null;
  const id = typeof body?.id === 'string' ? body.id : '';
  const status = body?.status;
  if (!id || (status !== 'approved' && status !== 'rejected' && status !== 'edited')) return apiError(400, 'bad_approval', 'Send an approval id and approved, rejected, or edited.');
  const decision = await decideApproval(user.id, id, status, body?.payload);
  if (decision.outcome === 'missing') return apiError(404, 'missing_approval', 'That approval is not yours or does not exist.');
  if (decision.outcome === 'expired') return apiError(409, 'expired', 'That approval expired. Ask for a new one.');
  if (decision.outcome === 'duplicate') return privateJson({outcome: 'duplicate', status: decision.status});
  let resume = null;
  if (decision.outcome === 'approved' && decision.approval?.runId) resume = await resumeAfterApproval(user.id, decision.approval.runId);
  await audit(user.id, 'approval.decide', 'ok', {status, action: decision.approval?.action ?? null});
  return privateJson({outcome: decision.outcome, resume});
}
