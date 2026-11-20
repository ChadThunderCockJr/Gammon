import { createHash, randomBytes } from "node:crypto";

type LogLevel = "info" | "warn" | "error" | "debug";

interface LogEntry {
  level: LogLevel;
  msg: string;
  ts: string;
  [key: string]: unknown;
}

const logHashSalt = process.env.LOG_HASH_SALT || randomBytes(32).toString("hex");
const sensitiveKeys = /^(authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|secret|password|api[_-]?key|private[_-]?key|bank.*|account.*|identity.*|document.*|ssn|payload|body|headers?|response|error)$/i;
const identifierKeys = /^(address|wallet|principal|signer|from|to|player[_-]?address)$/i;

function pseudonym(value: string): string {
  return `id:${createHash("sha256").update(logHashSalt).update("\0").update(value).digest("hex").slice(0, 12)}`;
}

function sanitizeValue(
  value: unknown,
  key: string,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (sensitiveKeys.test(key)) return "[REDACTED]";
  if (identifierKeys.test(key) && typeof value === "string") return pseudonym(value);
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value.length > 512 ? `${value.slice(0, 512)}…` : value;
  if (value instanceof Error) return { name: value.name };
  if (depth >= 4) return "[TRUNCATED]";
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitizeValue(entry, "", depth + 1, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 50)) {
      output[childKey] = sanitizeValue(childValue, childKey, depth + 1, seen);
    }
    return output;
  }
  return String(value);
}

export function redactLogData(data?: Record<string, unknown>): Record<string, unknown> {
  if (!data) return {};
  return sanitizeValue(data, "", 0, new WeakSet<object>()) as Record<string, unknown>;
}

function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  const entry: LogEntry = {
    level,
    msg: msg.length > 512 ? `${msg.slice(0, 512)}…` : msg,
    ts: new Date().toISOString(),
    ...redactLogData(data),
  };
  const output = JSON.stringify(entry);
  if (level === "error") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else {
    console.log(output);
  }
}

export const logger = {
  info: (msg: string, data?: Record<string, unknown>) => log("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log("error", msg, data),
  debug: (msg: string, data?: Record<string, unknown>) => log("debug", msg, data),
};
