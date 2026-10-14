import type {Task,Event,SourceStatus} from './types';
const tz='America/Los_Angeles';
export function todayLocal(){return new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
const demoTasks:Task[]=[
{id:'demo-1',title:'Review OpenSphere correspondence and identify the first response',status:'Ready',priority:'High',duration:30,context:'Laptop',energy:'Medium',source:'Demo — not synced'},
{id:'demo-2',title:'Check appointment rescheduling options',status:'Ready',priority:'High',duration:10,context:'Phone',energy:'Low',source:'Demo — not synced'},
{id:'demo-3',title:'Check PR review status (do not re-submit completed comments)',status:'Waiting',priority:'Medium',duration:5,context:'Phone',energy:'Low',source:'Demo — not synced'},
{id:'demo-4',title:'Choose one small home preparation zone',status:'Ready',priority:'Medium',duration:20,context:'Home',energy:'Medium',source:'Demo — not synced'}
];
const demoEvents:Event[]=[];
const rt=(x:any)=>Array.isArray(x)?x.map(y=>y.plain_text||y.text?.content||'').join(''):'';
export async function getSources():Promise<{tasks:Task[];events:Event[];status:SourceStatus;mode:string}>{
 let tasks:Task[]=[];let events:Event[]=[];let notion='Not configured';let calendar='Not configured';const warnings:string[]=[];
 const nt=process.env.NOTION_TOKEN,db=process.env.NOTION_DATABASE_ID;
 if(nt&&db){try{
 const res=await fetch(`https://api.notion.com/v1/databases/${db}/query`,{method:'POST',headers:{'Authorization':`Bearer ${nt}`,'Notion-Version':'2022-06-28','Content-Type':'application/json'},body:JSON.stringify({page_size:100}),cache:'no-store'});
 const body=await res.json();if(!res.ok)throw Error(body.message||`Notion ${res.status}`);
 tasks=(body.results||[]).map((p:any)=>({id:p.id,title:rt(p.properties?.Name?.title)||'Untitled',status:p.properties?.Status?.select?.name||'Ready',priority:p.properties?.Priority?.select?.name||'Medium',due:p.properties?.Due?.date?.start||undefined,duration:p.properties?.Duration?.number||15,context:p.properties?.Context?.select?.name||'Anywhere',energy:p.properties?.Energy?.select?.name||'Medium',source:'Notion',url:p.url}));notion='Connected';
 if(body.has_more)warnings.push('Notion has more than 100 tasks; add pagination before full use.');
 }catch(e){notion='Connection error';warnings.push(`Notion read failed: ${String(e)}`);}}
 if(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET&&process.env.GOOGLE_REFRESH_TOKEN){try{
 const tokenRes=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,refresh_token:process.env.GOOGLE_REFRESH_TOKEN,grant_type:'refresh_token'}),cache:'no-store'});
 const token=await tokenRes.json();if(!tokenRes.ok)throw Error(token.error_description||token.error||'Token exchange failed');
 const day=todayLocal();const start=`${day}T00:00:00-07:00`;const end=new Date(new Date(start).getTime()+36*3600000).toISOString();
 const q=new URLSearchParams({timeMin:new Date(start).toISOString(),timeMax:end,singleEvents:'true',orderBy:'startTime',maxResults:'100',timeZone:tz});
 const id=encodeURIComponent(process.env.GOOGLE_CALENDAR_ID||'primary');const response=await fetch(`https://www.googleapis.com/calendar/v3/calendars/${id}/events?${q}`,{headers:{Authorization:`Bearer ${token.access_token}`},cache:'no-store'});const data=await response.json();if(!response.ok)throw Error(data.error?.message||'Calendar read failed');
 events=(data.items||[]).filter((e:any)=>e.start?.dateTime).map((e:any)=>({id:e.id,title:e.summary||'Busy',start:e.start.dateTime,end:e.end.dateTime,source:'Google Calendar'}));calendar='Connected';
 }catch(e){calendar='Connection error';warnings.push(`Google Calendar read failed: ${String(e)}`);}}
 if(!nt||!db){tasks=demoTasks;notion='Demo only — Notion not configured';warnings.push('Demo tasks are examples, not verified live task state.');}
 if(events.length===0&&!process.env.GOOGLE_REFRESH_TOKEN){events=demoEvents;calendar='Not connected — no calendar availability claimed';}
 return {tasks,events,status:{notion,calendar,warnings},mode:(!nt||!db)?'DEMO MODE':'CONNECTED / PARTIAL'};
}
