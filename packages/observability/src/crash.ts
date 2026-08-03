import { redact } from "./redaction.js";
import type { JsonValue } from "./types.js";

export interface CrashReport { schemaVersion: 1; occurredAt: string; applicationVersion: string; platform: string; error: JsonValue; context: JsonValue }
export function serializeCrashReport(error: unknown, metadata: { applicationVersion: string; platform: string; context?: unknown; occurredAt?: Date }): string {
  const report: CrashReport = { schemaVersion: 1, occurredAt: (metadata.occurredAt ?? new Date()).toISOString(), applicationVersion: metadata.applicationVersion, platform: metadata.platform, error: redact(error), context: redact(metadata.context ?? {}) };
  return JSON.stringify(report, null, 2);
}
