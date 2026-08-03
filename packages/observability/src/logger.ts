import { redact, type RedactionOptions } from "./redaction.js";
import type { JsonValue, LogLevel, LogRecord } from "./types.js";

const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export interface LoggerOptions extends RedactionOptions { level?: LogLevel; capacity?: number; now?: () => Date }

export class LocalLogger {
  private level: LogLevel;
  private readonly capacity: number;
  private readonly records: LogRecord[] = [];
  constructor(private readonly options: LoggerOptions = {}) {
    this.level = options.level ?? "info";
    this.capacity = Math.max(1, Math.floor(options.capacity ?? 500));
  }
  setLevel(level: LogLevel): void { this.level = level; }
  debug(event: string, context: Record<string, unknown> = {}): void { this.write("debug", event, context); }
  info(event: string, context: Record<string, unknown> = {}): void { this.write("info", event, context); }
  warn(event: string, context: Record<string, unknown> = {}): void { this.write("warn", event, context); }
  error(event: string, context: Record<string, unknown> = {}): void { this.write("error", event, context); }
  write(level: LogLevel, event: string, context: Record<string, unknown> = {}): void {
    if (rank[level] < rank[this.level]) return;
    const safe = redact(context, this.options);
    this.records.push({ schemaVersion: 1, timestamp: (this.options.now?.() ?? new Date()).toISOString(), level, event, context: safe as Record<string, JsonValue> });
    if (this.records.length > this.capacity) this.records.splice(0, this.records.length - this.capacity);
  }
  list(): readonly LogRecord[] { return structuredClone(this.records); }
  clear(): void { this.records.length = 0; }
}
