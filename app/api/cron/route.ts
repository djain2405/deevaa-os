import {NextRequest,NextResponse} from 'next/server';import {generateBriefing} from '../../../lib/planner';
export const dynamic='force-dynamic';export async function GET(r:NextRequest){const secret=process.env.CRON_SECRET;if(!secret||r.headers.get('authorization')!==`Bearer ${secret}`)return NextResponse.json({error:'Unauthorized'},{status:401});
// v0: returns a computed plan. Persistence/delivery must be implemented before calling it autonomous.
return NextResponse.json({notice:'Dry run only; plan not persisted or delivered',briefing:await generateBriefing()});}
