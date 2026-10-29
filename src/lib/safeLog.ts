/**
 * Structured logging that never prints tokens, API keys, or other secrets.
 */

const SECRET_KEY =
  /^(authorization|cookie|set-cookie|x-admin-key|api[_-]?key|token|secret|password|service[_-]?role|bearer|refresh[_-]?token|access[_-]?token|x[_-]?token|encryption[_-]?key)$/i;

const SECRET_VALUE =
  /\b(sk-[a-zA-Z0-9_-]{8,}|sb_secret_[a-zA-Z0-9_-]+|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+|Bearer\s+[^\s]+|xox[baprs]-[^\s]+)\b/gi;

export function redactString(value: string): string {
  return value.replace(SECRET_VALUE, '[REDACTED]');
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value.length > 2000 ? `${value.slice(0, 2000)}…` : value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack.split('\n').slice(0, 8).join('\n')) : undefined,
    };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export type LogLevel = 'info' | 'warn' | 'error';

export function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: redactString(message),
    ...((redact(fields) as Record<string, unknown>) ?? {}),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
