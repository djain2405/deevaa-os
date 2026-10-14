export type Task={id:string;title:string;status:string;priority:string;due?:string;duration:number;context:string;energy:string;source:string;url?:string};
export type Event={id:string;title:string;start:string;end:string;source:string};
export type SourceStatus={notion:string;calendar:string;warnings:string[]};
export type Briefing={date:string;timezone:string;mode:string;tasks:Task[];events:Event[];sourceStatus:SourceStatus;blocks:{label:string;task?:Task;reason:string}[];nextAction?:Task;generatedAt:string};
