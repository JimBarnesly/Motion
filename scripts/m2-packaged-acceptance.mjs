import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runWithTimeout, startJsonLineService } from "./m2-process-control.mjs";

const appImage = process.argv[2] ? resolve(process.argv[2]) : null;
const reportPath = resolve(process.env.M2_ACCEPTANCE_REPORT ?? "artifacts/acceptance/m2-packaged.json");
const report = {
  schemaVersion: 1,
  milestone: "M2",
  candidate: process.env.GITHUB_SHA ?? null,
  evidence: {
    "source-test": { status: "not-run", checks: [] },
    "packaged-local": { status: "not-run", checks: [], networkPolicy: "process-level JavaScript network guard injected into packaged Node runtime; OS-level network denial remains external acceptance evidence" },
    "external-graphical": {
      status: "blocked",
      checks: [],
      blockers: [
        "This headless lane does not launch the installed Tauri window, exercise native file chooser/drop UI, clipboard, focus, previews, or responsive rendering.",
        "M2 completion still requires graphical acceptance on a Linux host with WebKitGTK/display support and OS-level networking disabled."
      ]
    }
  },
  failures: [],
  result: "failed"
};

async function persistReport() {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function findFile(directory, name) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) { const found = await findFile(path, name); if (found) return found; }
  }
  return null;
}

function packagedService(node, runner, dataRoot) {
  const guard = resolve("scripts/deny-network.cjs");
  return startJsonLineService(node, [runner, dataRoot], {
    env: { ...process.env, MOTION_E2E_NETWORK_GUARD: "required", NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${guard}`].filter(Boolean).join(" ") },
    requestTimeoutMs: 30_000
  });
}

const root = await mkdtemp(join(tmpdir(), "motion-m2-acceptance-"));
let service = null;
try {
  const sourceCommands = [
    ["npm", ["run", "test", "--workspace", "@motion/web"]],
    ["npm", ["run", "test", "--workspace", "@motion/app-service"]],
    ["npm", ["run", "test", "--workspace", "@motion/backup"]]
  ];
  const sourceFailures = [];
  for (const [command, args] of sourceCommands) {
    const check = `${command} ${args.join(" ")}`;
    try {
      await runWithTimeout(command, args);
      report.evidence["source-test"].checks.push({ check, status: "passed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.evidence["source-test"].checks.push({ check, status: "failed", diagnostic: message });
      sourceFailures.push(message);
    }
  }
  report.evidence["source-test"].status = sourceFailures.length ? "failed" : "passed";

  if (!appImage) throw new Error("Usage: npm run acceptance:m2:packaged -- <Motion.AppImage>");
  let appImageMetadata;
  try { appImageMetadata = await stat(appImage); }
  catch (error) { throw new Error(`AppImage not found: ${appImage}`, { cause: error }); }
  assert.ok(appImageMetadata.isFile(), `AppImage is not a file: ${appImage}`);
  await chmod(appImage, 0o755);
  await runWithTimeout(appImage, ["--appimage-extract"], { cwd: root, env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" } });
  const extracted = join(root, "extracted");
  await rename(join(root, "squashfs-root"), extracted);
  const node = await findFile(extracted, "node-runtime");
  const runner = await findFile(extracted, "service-bundle.mjs");
  assert.ok(node, "packaged Node runtime is missing");
  assert.ok(runner, "packaged service bundle is missing");
  assert.match((await runWithTimeout(node, ["--version"])).stdout.trim(), /^v24\./, "packaged runtime is not pinned Node 24");

  const dataRoot = join(root, "data");
  service = packagedService(node, runner, dataRoot);
  let state = await service.request("command", { type: "workspace.create", name: "M2 packaged acceptance" });
  const workspaceId = state.workspace.id;
  state = await service.request("command", { type: "page.create", workspaceId, expectedRevision: state.revision, title: "Source" });
  const sourceId = state.workspace.pages.find(page => page.title === "Source").id;
  state = await service.request("command", { type: "page.create", workspaceId, expectedRevision: state.revision, title: "Target" });
  const targetId = state.workspace.pages.find(page => page.title === "Target").id;
  state = await service.request("command", { type: "page.create", workspaceId, expectedRevision: state.revision, title: "Folder" });
  const folderId = state.workspace.pages.find(page => page.title === "Folder").id;
  state = await service.request("command", { type: "page.replace-blocks", workspaceId, expectedRevision: state.revision, pageId: sourceId,
    blocks: [{ id: "m2-link-block", type: "paragraph", text: "See [[Target]]", children: [], references: [{ pageId: targetId, start: 4, end: 14 }] }] });
  state = await service.request("command", { type: "page.rename", workspaceId, expectedRevision: state.revision, pageId: targetId, title: "Renamed target" });
  state = await service.request("command", { type: "page.move", workspaceId, expectedRevision: state.revision, pageId: targetId, parentId: folderId });
  const backlinks = await service.request("query", { type: "page.backlinks", workspaceId, pageId: targetId });
  assert.equal(backlinks.length, 1, "stable backlink did not survive rename/move in packaged runtime");
  assert.equal(backlinks[0].sourcePageId, sourceId);

  const bytes = [77, 50, 32, 111, 102, 102, 108, 105, 110, 101];
  state = await service.request("async-command", { type: "attachment.ingest-block", workspaceId, expectedRevision: state.revision, pageId: sourceId,
    position: { parentBlockId: null, beforeBlockId: null }, attachmentId: "m2-attachment", blockId: "m2-attachment-block", fileName: "offline-proof.txt",
    mediaType: "text/plain", sha256: "9f9484e86a5499e1853991e91daee8f3ef340d5f1987d1190e554fee8c55aff2", bytes: { $motionBytes: bytes } });
  const readAttachment = await service.request("async-query", { type: "attachment.read", workspaceId, attachmentId: "m2-attachment" });
  assert.deepEqual(readAttachment.bytes.$motionBytes, bytes, "packaged attachment bytes differ after durable ingestion");

  const backup = await service.request("async-query", { type: "backup.create", workspaceId, createdAt: "2026-08-12T00:00:00.000Z" });
  const restored = await service.request("async-command", { type: "backup.restore-new", bundle: backup, newWorkspaceId: "m2-restored" });
  await service.close();
  service = null;

  service = packagedService(node, runner, dataRoot);
  const reopened = await service.request("query", { type: "workspace.get", workspaceId: restored.workspace.id });
  const reopenedSource = reopened.workspace.pages.find(page => page.title === "Source");
  const reopenedTarget = reopened.workspace.pages.find(page => page.title === "Renamed target");
  assert.ok(reopenedSource && reopenedTarget, "restored linked pages are missing after packaged restart");
  const restoredBacklinks = await service.request("query", { type: "page.backlinks", workspaceId: reopened.workspace.id, pageId: reopenedTarget.id });
  assert.equal(restoredBacklinks.length, 1, "restored backlink index is missing after packaged restart");
  const restoredAttachment = reopened.workspace.attachments.find(attachment => attachment.fileName === "offline-proof.txt");
  assert.ok(restoredAttachment, "restored attachment metadata is missing");
  const restoredBytes = await service.request("async-query", { type: "attachment.read", workspaceId: reopened.workspace.id, attachmentId: restoredAttachment.id });
  assert.deepEqual(restoredBytes.bytes.$motionBytes, bytes, "restored packaged attachment bytes differ");
  await service.close();
  service = null;

  report.evidence["packaged-local"].status = "passed";
  report.evidence["packaged-local"].checks = [
    "AppImage extraction and bundled Node 24 runtime",
    "packaged service execution with the process-level JavaScript network guard",
    "stable-ID backlink after target rename and move",
    "durable attachment ingestion and byte readback",
    "full backup restore into a new workspace",
    "process termination, restart, restored backlink query, and attachment byte readback"
  ];
  if (sourceFailures.length) throw new Error(`Source prerequisite failures (${sourceFailures.length}); packaged checks passed but the lane remains failed. See source-test diagnostics.`);
  report.result = "automated-lane-passed-external-graphical-pending";
} catch (error) {
  report.failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  await service?.terminate();
  await persistReport();
  await rm(root, { recursive: true, force: true });
  process.stdout.write(`M2 acceptance report: ${reportPath}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
