import {getSources,todayLocal} from './sources';import type {Briefing,Task} from './types';
const excluded=new Set(['Done','Canceled','Waiting','Blocked','Waiting for User']);
function score(t:Task){const p=t.priority==='High'?60:t.priority==='Urgent'?100:t.priority==='Medium'?30:10;const d=t.due?Math.max(0,35-Math.floor((new Date(t.due).getTime()-Date.now())/86400000)*5):0;return p+d;}
export async function generateBriefing():Promise<Briefing>{const s=await getSources();const ready=s.tasks.filter(t=>!excluded.has(t.status)).sort((a,b)=>score(b)-score(a));
const focus=ready.find(t=>t.duration>=25)||ready[0];const close=ready.find(t=>t.id!==focus?.id&&t.duration<=15);const maintain=ready.find(t=>t.id!==focus?.id&&t.id!==close?.id&&/home|health|fitness|gym|meal|appointment|doctor/i.test(t.title));
const blocks=[{label:'FOCUS',task:focus,reason:'Highest priority meaningful task; reserve a dedicated window.'},{label:'CLOSE',task:close,reason:'One small outstanding loop; do not stack.'},{label:'MAINTAIN',task:maintain,reason:'Support health or home; skip if no suitable task.'},{label:'EXPAND',reason:'Reserve for people, learning, connection or creativity; do not invent an obligation.'}];
const nextAction=ready.find(t=>t.duration<=10)||ready[0];
return {date:todayLocal(),timezone:'America/Los_Angeles',mode:s.mode,tasks:s.tasks,events:s.events,sourceStatus:s.status,blocks,nextAction,generatedAt:new Date().toISOString()};}
