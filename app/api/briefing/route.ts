import {NextResponse} from 'next/server';import {generateBriefing} from '../../../lib/planner';
export const dynamic='force-dynamic';export async function GET(){try{return NextResponse.json(await generateBriefing(),{headers:{'Cache-Control':'no-store'}})}catch(e){return NextResponse.json({error:String(e)},{status:500})}}
