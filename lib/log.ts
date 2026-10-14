type Level = 'info' | 'warn' | 'error';
type Field = string | number | boolean | null | undefined;

const SENSITIVE_KEY = /token|secret|password|authorization|cookie|code|state|description|attendee|email|body|summary|title/i;

export function sanitizeFields(fields: Record<string, unknown>): Record<string, Field> {
  const out: Record<string, Field> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = '[redacted]';
    } else if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value as Field;
    } else if (typeof value === 'string') {
      out[key] = value.length > 120 ? `${value.slice(0, 120)}…` : value;
    } else {
      out[key] = '[omitted]';
    }
  }
  return out;
}

export function logEvent(level: Level, op: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({level, op, at: new Date().toISOString(), ...sanitizeFields(fields)});
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}
