import type { DatabaseDiagnostic, IndexDiagnostic, LogRecord, PerformanceSpan, SyncDiagnostic } from "./types.js";

export interface SupportBundleInput { appVersion: string; generatedAt?: Date; logs?: readonly LogRecord[]; sync?: SyncDiagnostic; database?: DatabaseDiagnostic; index?: IndexDiagnostic; performance?: readonly PerformanceSpan[]; crashReports?: readonly string[] }
export interface SupportBundleManifest { schemaVersion: 1; generatedAt: string; appVersion: string; files: Array<{ path: string; description: string; recordCount?: number }>; exclusions: readonly string[] }
export interface SupportBundle { manifest: SupportBundleManifest; files: Readonly<Record<string, string>> }

function entries(input: SupportBundleInput): Array<[string, string, unknown, number?]> {
  const result: Array<[string, string, unknown, number?]> = [];
  if (input.logs) result.push(["logs.json", "Redacted local structured logs", input.logs, input.logs.length]);
  if (input.sync) result.push(["diagnostics/sync.json", "Synchronisation state without workspace content", input.sync]);
  if (input.database) result.push(["diagnostics/database.json", "Database health summary", input.database]);
  if (input.index) result.push(["diagnostics/index.json", "Search index health summary", input.index]);
  if (input.performance) result.push(["performance.json", "Opt-in local development spans", input.performance, input.performance.length]);
  input.crashReports?.forEach((report, index) => result.push([`crashes/${index + 1}.json`, "Redacted local crash report", JSON.parse(report) as unknown]));
  return result;
}
export function previewSupportBundle(input: SupportBundleInput): SupportBundleManifest {
  return { schemaVersion: 1, generatedAt: (input.generatedAt ?? new Date()).toISOString(), appVersion: input.appVersion, files: entries(input).map(([path, description, , recordCount]) => ({ path, description, ...(recordCount === undefined ? {} : { recordCount }) })), exclusions: ["workspace document content", "attachments", "credentials and encryption keys", "network transmission"] };
}
export function buildSupportBundle(input: SupportBundleInput): SupportBundle {
  const manifest = previewSupportBundle(input);
  const files = Object.fromEntries(entries(input).map(([path, , value]) => [path, JSON.stringify(value, null, 2)]));
  return { manifest, files: { "manifest.json": JSON.stringify(manifest, null, 2), ...files } };
}
