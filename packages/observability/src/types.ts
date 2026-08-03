export type LogLevel = "debug" | "info" | "warn" | "error";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface LogRecord {
  schemaVersion: 1;
  timestamp: string;
  level: LogLevel;
  event: string;
  context: Readonly<Record<string, JsonValue>>;
}

export interface SyncDiagnostic {
  state: "local-only" | "synchronised" | "synchronising" | "offline" | "unsynchronised" | "auth-required" | "conflict" | "server-unavailable" | "encryption-error";
  pendingOperations: number;
  lastSuccessfulSyncAt?: string;
  serverOrigin?: string;
  errorCode?: string;
}

export interface DatabaseDiagnostic {
  integrity: "ok" | "warning" | "failed" | "not-run";
  schemaVersion: number;
  migrationState: "idle" | "running" | "failed";
  sizeBytes?: number;
  checkedAt?: string;
  issues: readonly string[];
}

export interface IndexDiagnostic {
  state: "ready" | "indexing" | "stale" | "failed" | "not-built";
  indexedDocuments: number;
  pendingDocuments: number;
  checkedAt?: string;
  errorCode?: string;
}

export interface PerformanceSpan {
  name: string;
  startedAt: string;
  durationMs: number;
  attributes: Readonly<Record<string, JsonValue>>;
}
