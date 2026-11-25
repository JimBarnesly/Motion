// Run only through windows-mapped-share-acceptance.ps1 with the installed Node
// runtime. A reachable SMB mapping is a real OS fixture, never a mocked volume.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

assert.equal(process.platform, "win32", "Mapped SMB acceptance requires actual Windows");
assert.equal(process.env.GITHUB_ACTIONS, "true", "This fixture is restricted to disposable Actions runners");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "A disposable hosted runner is required");

const [mode, backing, mapped, ...extra] = process.argv.slice(2);
assert.ok(mode === "prepare" || mode === "verify", "Expected the prepare or verify fixture phase");
assert.equal(extra.length, 0);
assert.ok(backing && isAbsolute(backing));
assert.equal(basename(backing), "backing");
assert.match(basename(dirname(backing)), /^motion-smb-[a-f0-9]{32}$/);
assert.ok(process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP), "An absolute RUNNER_TEMP is required");
const insideTemporary = relative(resolve(process.env.RUNNER_TEMP), backing);
assert.ok(insideTemporary && !isAbsolute(insideTemporary) && insideTemporary !== ".."
  && !insideTemporary.startsWith(`..${sep}`), "The fixture must be inside RUNNER_TEMP");
assert.equal(mapped === undefined, mode === "prepare");
if (mapped !== undefined) assert.match(mapped, /^[A-Z]:\\$/);

const helper = process.env.MOTION_NATIVE_HELPER;
const runtime = process.env.MOTION_TEST_NODE_BINARY;
const service = process.env.MOTION_TEST_SERVICE_BUNDLE;
for (const file of [helper, runtime, service]) {
  assert.ok(file && isAbsolute(file), "Installed application resources must be explicitly selected");
  const metadata = lstatSync(file);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink(), "An installed resource is not a regular file");
}
assert.equal(resolve(process.execPath).toLowerCase(), resolve(runtime).toLowerCase(),
  "The verifier must run with the installed Node executable");

const sentinelName = "sentinel.json";
const sentinel = JSON.stringify({ purpose: "Motion mapped SMB rejection control", schemaVersion: 1 });
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const maxOutput = 128 * 1024;

function child(executable, args, input, environment = {}) {
  const result = spawnSync(executable, args, {
    input, encoding: "utf8", windowsHide: true, shell: false,
    env: { ...process.env, ...environment }, timeout: 15_000, killSignal: "SIGKILL", maxBuffer: maxOutput
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, "A fixture process exceeded its bounded execution time");
  assert.ok(Number.isInteger(result.status), "The actual installed process did not produce an exit status");
  return result;
}

function native(request, expectedOk) {
  const result = child(helper, ["--motion-native-helper"], JSON.stringify({ protocol: 1, ...request }));
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.protocol, 1, "The installed helper must return its real protocol envelope");
  assert.equal(reply.ok, expectedOk, `Unexpected native result for ${request.operation}: ${result.stdout}`);
  assert.equal(result.status, expectedOk ? 0 : 1, "Helper exit status and protocol outcome disagree");
  if (expectedOk) {
    assert.deepEqual(Object.keys(reply).sort(), ["ok", "protocol", "result"]);
    assert.ok(reply.result && typeof reply.result === "object");
    return reply.result;
  }
  assert.deepEqual(Object.keys(reply).sort(), ["error", "ok", "protocol"]);
  assert.deepEqual(Object.keys(reply.error).sort(), ["code", "message"]);
  assert.ok(["ENOENT", "EACCES", "INVALID_INPUT", "STORAGE_FAILURE"].includes(reply.error.code),
    "Rejection must come from native path validation, not a competing writer or helper launch failure");
  assert.equal(typeof reply.error.message, "string");
  return reply.error.code;
}

function runService(root) {
  return child(runtime, [service, root], "MOTION_SERVICE_START\n"
    + JSON.stringify({ lane: "command", payload: { type: "workspace.create", name: "Mapped volume control" } }) + "\n",
  { MOTION_SERVICE_START_GATE: "1" });
}

function snapshot(root) {
  const entries = [];
  const visit = (path, name) => {
    assert.ok(entries.length < 128, "Fixture tree unexpectedly exceeded its entry bound");
    const metadata = lstatSync(path, { bigint: true });
    assert.ok(!metadata.isSymbolicLink(), "The controlled fixture must contain no reparse links");
    const item = { name, device: String(metadata.dev), file: String(metadata.ino), links: String(metadata.nlink) };
    if (metadata.isDirectory()) {
      entries.push({ ...item, type: "directory" });
      for (const childName of readdirSync(path).sort()) visit(join(path, childName), name ? `${name}/${childName}` : childName);
    } else {
      assert.ok(metadata.isFile() && metadata.size <= 16n * 1024n * 1024n, "Unexpected fixture object or size");
      entries.push({ ...item, type: "file", size: String(metadata.size), sha256: sha256(readFileSync(path)) });
    }
  };
  visit(root, "");
  return entries;
}

if (mode === "prepare") {
  // The native helper, not an elevated mkdir, establishes genuine current-user
  // ownership. Local controls exercise the same request shapes used below.
  const root = native({ operation: "private.directory", path: backing, create: true }, true);
  assert.match(root.identity, /^[a-f0-9]{64}$/);
  native({ operation: "backup.save", path: join(backing, sentinelName), contents: sentinel }, true);
  const controls = join(backing, "local-controls");
  native({ operation: "private.directory", path: controls, create: true }, true);
  const attachments = native({ operation: "attachment.initialize", root: join(controls, "attachments") }, true);
  assert.match(attachments.rootIdentity, /^[a-f0-9]{64}$/);
  assert.match(attachments.stagingIdentity, /^[a-f0-9]{64}$/);
  const positive = runService(join(controls, "service"));
  assert.equal(positive.status, 0, positive.stderr);
  const replies = positive.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, true);
  assert.equal(replies[0].value.workspace.name, "Mapped volume control");
  console.log(JSON.stringify({ localNativeControls: true, localServiceControl: true }));
} else {
  // This child inherits the mapping creator's logon token. Ordinary Win32/Node
  // reads AND writes must work before any native refusal can count as evidence.
  const readable = () => assert.equal(readFileSync(join(mapped, sentinelName), "utf8"), sentinel);
  readable();
  const probe = join(mapped, `access-probe-${process.pid}.txt`);
  writeFileSync(probe, "mapped write control", { flag: "wx" });
  assert.equal(readFileSync(probe, "utf8"), "mapped write control");
  assert.equal(readFileSync(join(backing, basename(probe)), "utf8"), "mapped write control");
  unlinkSync(probe);
  assert.equal(native({ operation: "backup.inspect", path: join(backing, sentinelName) }, true).contents, sentinel);
  native({ operation: "private.directory", path: backing, create: false }, true);
  const before = snapshot(backing);
  const refusals = {};
  const attempts = [
    ["existingDirectory", { operation: "private.directory", path: mapped, create: false }],
    ["newDirectory", { operation: "private.directory", path: join(mapped, "remote-root"), create: true }],
    ["attachments", { operation: "attachment.initialize", root: join(mapped, "remote-attachments") }],
    ["backupInspection", { operation: "backup.inspect", path: join(mapped, sentinelName) }],
    ["backupCreation", { operation: "backup.save", path: join(mapped, "remote-backup.json"), contents: sentinel }]
  ];
  for (const [name, request] of attempts) {
    refusals[name] = native(request, false);
    readable();
    assert.deepEqual(snapshot(backing), before, `${name} changed the physical target before rejecting the mapping`);
  }
  const refused = runService(join(mapped, "remote-service"));
  assert.notEqual(refused.status, 0, "The actual installed service must refuse a mapped data root");
  assert.equal(refused.stdout.trim(), "", "A rejected service must not process the queued mutation");
  assert.match(refused.stderr, /MOTION_DATA_ROOT_BUSY/,
    "Service rejection must reach native ownership validation, not fail to load its bundle");
  readable();
  assert.deepEqual(snapshot(backing), before, "Mapped service startup changed the physical target");
  console.log(JSON.stringify({
    mappedReadWriteControl: true, nativeMappedVolumeRejected: true, installedServiceRejected: true,
    physicalTreeUnchanged: true, refusals, node: process.version,
    nativeHelperSha256: sha256(readFileSync(helper)), serviceBundleSha256: sha256(readFileSync(service))
  }));
}
