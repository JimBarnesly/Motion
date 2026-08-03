import type { JsonValue } from "./types.js";

const DEFAULT_SENSITIVE_KEYS = /(?:password|passphrase|secret|token|authorization|cookie|api[-_]?key|encryption[-_]?key|document(?:text|content|body)|block(?:text|content)|page(?:text|content|body))/i;
const SECRET_IN_TEXT = /\b(?:bearer\s+[a-z0-9._~+\/-]+=*|(?:api[-_]?key|token|password|secret)\s*[:=]\s*[^\s,;]+)/gi;
export const REDACTED = "[REDACTED]";

export interface RedactionOptions { sensitiveKeys?: RegExp; redactTextPatterns?: readonly RegExp[] }

export function redact(value: unknown, options: RedactionOptions = {}): JsonValue {
  const seen = new WeakSet<object>();
  const keyPattern = options.sensitiveKeys ?? DEFAULT_SENSITIVE_KEYS;
  const textPatterns = options.redactTextPatterns ?? [SECRET_IN_TEXT];
  const visit = (entry: unknown, key?: string): JsonValue => {
    if (key && keyPattern.test(key)) return REDACTED;
    if (entry === null || typeof entry === "boolean" || typeof entry === "number") return entry;
    if (typeof entry === "string") return textPatterns.reduce((text, pattern) => text.replace(new RegExp(pattern.source, pattern.flags), REDACTED), entry);
    if (typeof entry === "bigint") return entry.toString();
    if (entry instanceof Error) return { name: entry.name, message: visit(entry.message, "errorMessage"), stack: entry.stack ? visit(entry.stack, "errorStack") : null };
    if (Array.isArray(entry)) return entry.map((item) => visit(item));
    if (typeof entry === "object") {
      if (seen.has(entry)) return "[CIRCULAR]";
      seen.add(entry);
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>).map(([childKey, child]) => [childKey, visit(child, childKey)]));
    }
    return String(entry ?? "");
  };
  return visit(value);
}
