#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MotionAppError, MotionAppService, toAppError } from "@motion/app-service";
import { LocalLogger, buildSupportBundle, serializeCrashReport } from "@motion/observability";
import { ContentAddressedAttachmentStore, SqliteWorkspaceStore } from "@motion/storage";

const [outputDirectory, canary, mode = "safe"] = process.argv.slice(2);
if (!outputDirectory || !canary) throw new Error("Usage: diagnostic-leakage-worker <output-directory> <canary> [safe|leak]");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const root = await mkdtemp(join(tmpdir(), "motion-diagnostic-gate-"));
const logger = new LocalLogger({ now: () => new Date("2026-08-05T00:00:00.000Z") });
const failures = [];
const boundaryCanary = operation => `${canary}_${operation.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}`;

const record = (operation, error) => {
  const safe = toAppError(error);
  const diagnostic = { operation, code: safe.code, message: safe.message, details: safe.details ?? {} };
  failures.push(diagnostic);
  logger.error("operation.failed", diagnostic);
  return safe;
};
const expectFailure = async (operation, action, expectedCode) => {
  try { await action(); throw new Error(`Expected ${operation} to fail`); }
  catch (error) {
    const safe = record(operation, error);
    if (safe.code !== expectedCode) throw new Error(`${operation} returned ${safe.code}, expected ${expectedCode}`);
  }
};

class FaultStore extends SqliteWorkspaceStore {
  failCommit = false;
  overrideMessage = "";
  saveUnitOfWork(write) {
    if (this.failCommit) throw new Error(this.overrideMessage);
    return super.saveUnitOfWork(write);
  }
}
class FaultAttachments extends ContentAddressedAttachmentStore {
  failRead = false;
  failRecovery = false;
  failureCanary = canary;
  async get(sha256) { if (this.failRead) throw new Error(`read ${this.failureCanary} ${sha256}`); return super.get(sha256); }
  async recover(hashes) { if (this.failRecovery) throw new Error(`startup recovery ${this.failureCanary}`); return super.recover(hashes); }
}

try {
  const databasePath = join(root, `database-${canary}.sqlite3`);
  const attachmentRoot = join(root, `attachments-${canary}`);
  const store = new FaultStore(databasePath);
  const attachments = new FaultAttachments(attachmentRoot);
  const service = new MotionAppService(store, attachments);
  const created = service.execute({ type: "workspace.create", name: `metadata-${canary}` });
  const bytes = new TextEncoder().encode(`content-${canary}`);

  await expectFailure("import", () => service.execute({ type: "workspace.import-web-v1", document: { schemaVersion: 999, metadata: boundaryCanary("import"), pages: [] }, workspaceId: `import-${canary}` }), "VALIDATION_FAILED");
  store.failCommit = true; store.overrideMessage = `SQLITE commit ${boundaryCanary("storage.commit")} ${databasePath}`;
  await expectFailure("storage.commit", () => service.execute({ type: "workspace.create", name: `commit-${canary}` }), "STORAGE_FAILURE");
  store.failCommit = false;
  store.failCommit = true; store.overrideMessage = `commit ${boundaryCanary("attachment.write")} ${databasePath}`;
  await expectFailure("attachment.write", () => service.executeAsync({ type: "attachment.put", workspaceId: created.workspace.id, expectedRevision: created.revision, id: `attachment-${canary}`, fileName: `file-${canary}.txt`, mediaType: `type/${canary}`, sha256: hash(bytes), bytes }), "STORAGE_FAILURE");
  store.failCommit = false;
  const attached = await service.executeAsync({ type: "attachment.put", workspaceId: created.workspace.id, expectedRevision: created.revision, id: randomUUID(), fileName: `file-${canary}.txt`, mediaType: "text/plain", sha256: hash(bytes), bytes });
  attachments.failRead = true;
  attachments.failureCanary = boundaryCanary("attachment.read");
  await expectFailure("attachment.read", () => service.queryAsync({ type: "attachment.read", workspaceId: created.workspace.id, attachmentId: attached.workspace.attachments[0].id }), "INTERNAL_ERROR");
  attachments.failureCanary = boundaryCanary("backup.create");
  await expectFailure("backup.create", () => service.queryAsync({ type: "backup.create", workspaceId: created.workspace.id }), "INTERNAL_ERROR");
  attachments.failRead = false;
  const bundle = await service.queryAsync({ type: "backup.create", workspaceId: created.workspace.id });
  store.failCommit = true; store.overrideMessage = `restore ${boundaryCanary("backup.restore")} ${databasePath}`;
  await expectFailure("backup.restore", () => service.executeAsync({ type: "backup.restore-new", bundle, newWorkspaceId: `restore-${canary}` }), "STORAGE_FAILURE");
  store.failCommit = false;
  attachments.failRecovery = true;
  attachments.failureCanary = boundaryCanary("startup.recovery");
  await expectFailure("startup.recovery", () => service.queryAsync({ type: "backup.verify", bundle }), "INTERNAL_ERROR");
  attachments.failRecovery = false;
  store.close();

  const invalidOpenPath = join(root, `open-${canary}`);
  await mkdir(invalidOpenPath);
  await expectFailure("storage.open", async () => { const opened = new SqliteWorkspaceStore(invalidOpenPath); opened.close(); }, "STORAGE_FAILURE");

  const crashReports = failures.map(failure => serializeCrashReport(new MotionAppError(failure.code, failure.message, failure.details), {
    applicationVersion: "0.1.0", platform: process.platform, context: { operation: failure.operation }, occurredAt: new Date("2026-08-05T00:00:00.000Z")
  }));
  const support = buildSupportBundle({ appVersion: "0.1.0", generatedAt: new Date("2026-08-05T00:00:00.000Z"), logs: logger.list(), crashReports,
    database: { integrity: "failed", schemaVersion: 1, migrationState: "failed", issues: failures.map(item => `${item.operation}:${item.code}`) } });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, "returned-errors.json"), JSON.stringify(failures, null, 2), { mode: 0o600 });
  await writeFile(join(outputDirectory, "structured-logs.json"), JSON.stringify(logger.list(), null, 2), { mode: 0o600 });
  await writeFile(join(outputDirectory, "generated-diagnostics.json"), JSON.stringify(support, null, 2), { mode: 0o600 });
  process.stdout.write(`Diagnostic fixture completed: ${failures.length} redacted failures captured.\n`);
  process.stderr.write("Representative failure channels captured with stable error codes.\n");
  if (mode === "leak") process.stdout.write(`UNREDACTED_FIXTURE=${canary}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
