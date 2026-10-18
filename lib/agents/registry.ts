import {DateTime} from 'luxon';
import {TIMEZONE} from '../types';
import {runGmailMorning} from './gmail-morning';

export type AgentHandler = (ctx: {userId: string; localDate: string; runId: string; now: Date; dryRun?: boolean}) => Promise<{briefingId?: string}>;

export type AgentDef = {
  id: string;
  title: string;
  timezone: string;
  localHour: number;
  handler: AgentHandler;
};

export const AGENTS: AgentDef[] = [
  {id: 'gmail.morning', title: 'Morning Gmail digest', timezone: TIMEZONE, localHour: 7, handler: runGmailMorning}
];

export function listAgents() {
  return AGENTS;
}

export function getAgent(id: string) {
  return AGENTS.find((a) => a.id === id) ?? null;
}

export function agentLocalDate(agent: AgentDef, now: Date) {
  return DateTime.fromJSDate(now).setZone(agent.timezone).toISODate()!;
}

/** True for the whole local hour so a missed :00 tick can still run at :15/:30/:45. */
export function isAgentDue(agent: AgentDef, now: Date) {
  return DateTime.fromJSDate(now).setZone(agent.timezone).hour === agent.localHour;
}

/** Local hour on the agent's timezone. */
export function agentLocalHour(agent: AgentDef, now: Date) {
  return DateTime.fromJSDate(now).setZone(agent.timezone).hour;
}

/** Catch-up window after the scheduled hour, inclusive of noon (hour 12). */
export const CATCH_UP_UNTIL_HOUR = 12;

export function isCatchUpHour(agent: AgentDef, now: Date) {
  const hour = agentLocalHour(agent, now);
  return hour > agent.localHour && hour <= CATCH_UP_UNTIL_HOUR;
}
